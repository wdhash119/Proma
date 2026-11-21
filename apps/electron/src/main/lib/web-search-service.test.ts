import { describe, expect, test } from 'bun:test'
import { defaultFetcher, formatWebSearchOutcome, parseDuckDuckGoHtml, resolveDuckDuckGoHref, searchWeb } from './web-search-service'

/** 构造一段与 DuckDuckGo HTML 结果页结构一致的最小样例。 */
function ddgPage(items: Array<{ title: string; href: string; snippet?: string }>): string {
  return items
    .map((item) => `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="${item.href}">${item.title}</a>
          </h2>
          ${item.snippet ? `<a class="result__snippet" href="${item.href}">${item.snippet}</a>` : ''}
        </div>
      </div>`)
    .join('\n')
}

describe('跳转链接解析', () => {
  test('Given 直链 When 解析 Then 原样返回', () => {
    expect(resolveDuckDuckGoHref('https://example.com/a')).toBe('https://example.com/a')
  })

  test('Given DuckDuckGo 跳转链接 When 解析 Then 取出真实地址', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb%3Fx%3D1&rut=abc'
    expect(resolveDuckDuckGoHref(href)).toBe('https://example.com/b?x=1')
  })

  test('Given 非 http 或相对链接 When 解析 Then 拒绝', () => {
    expect(resolveDuckDuckGoHref('javascript:alert(1)')).toBeNull()
    expect(resolveDuckDuckGoHref('mailto:a@b.c')).toBeNull()
    expect(resolveDuckDuckGoHref('')).toBeNull()
    expect(resolveDuckDuckGoHref('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeNull()
  })
})

describe('结果页解析', () => {
  test('Given 多个结果 When 解析 Then 保留标题、链接与摘要', () => {
    const html = ddgPage([
      { title: '第一篇', href: 'https://example.com/1', snippet: '摘要一' },
      { title: '第二篇', href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F2', snippet: '摘要二' },
    ])

    expect(parseDuckDuckGoHtml(html, 10)).toEqual([
      { title: '第一篇', url: 'https://example.com/1', snippet: '摘要一' },
      { title: '第二篇', url: 'https://example.com/2', snippet: '摘要二' },
    ])
  })

  test('Given 结果数量超过上限 When 解析 Then 只取前 N 条', () => {
    const html = ddgPage(
      Array.from({ length: 6 }, (_item, index) => ({
        title: `结果 ${index}`,
        href: `https://example.com/${index}`,
      })),
    )

    expect(parseDuckDuckGoHtml(html, 3)).toHaveLength(3)
  })

  test('Given 重复链接 When 解析 Then 去重', () => {
    const html = ddgPage([
      { title: 'A', href: 'https://example.com/same' },
      { title: 'B', href: 'https://example.com/same' },
    ])

    expect(parseDuckDuckGoHtml(html, 10).map((item) => item.title)).toEqual(['A'])
  })

  test('Given 实体与换行 When 解析 Then 文本被清理成单行', () => {
    const html = ddgPage([{ title: 'A &amp; B\n  多行', href: 'https://example.com/x', snippet: 'a &lt; b' }])

    const [item] = parseDuckDuckGoHtml(html, 10)
    expect(item?.title).toBe('A & B 多行')
    expect(item?.snippet).toBe('a < b')
  })

  test('Given 结构完全不同的页面 When 解析 Then 返回空数组', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>', 10)).toEqual([])
  })
})

describe('检索编排', () => {
  test('Given 注入的抓取实现 When 检索 Then 返回解析结果', async () => {
    const outcome = await searchWeb('proma agent', {
      count: 5,
      fetcher: async () => ddgPage([{ title: 'Proma', href: 'https://proma.cool', snippet: '桌面 Agent' }]),
    })

    expect(outcome).toMatchObject({ ok: true, query: 'proma agent', resultCount: 1 })
  })

  test('Given 没有结果 When 检索 Then 成功但带提示', async () => {
    const outcome = await searchWeb('nothing', { fetcher: async () => '<html></html>' })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.resultCount).toBe(0)
      expect(outcome.note).toContain('没有解析到结果')
    }
  })

  test('Given 抓取抛错 When 检索 Then 返回可读错误与替代建议', async () => {
    const outcome = await searchWeb('x', {
      fetcher: async () => { throw new Error('搜索服务返回 HTTP 429') },
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('429')
      expect(outcome.hint).toContain('受管浏览器')
    }
  })

  test('Given 空查询或超长查询 When 检索 Then 直接拒绝', async () => {
    expect((await searchWeb('   ')).ok).toBe(false)
    expect((await searchWeb('x'.repeat(129))).ok).toBe(false)
  })
})

describe('默认抓取实现', () => {
  test('Given 超过 2MiB 的响应 When 抓取 Then 保留量受限且取消剩余下载', async () => {
    const maxBytes = 2 * 1024 * 1024
    let canceled = false
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 40) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61))
      },
      cancel() {
        canceled = true
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch

    try {
      const html = await defaultFetcher('https://example.com/search')
      expect(html.length).toBe(maxBytes)
      expect(canceled).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Given 已经 aborted 的 signal When 抓取 Then 不发起 fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      called = true
      return new Response('<html></html>', { status: 200 })
    }) as unknown as typeof fetch

    try {
      await expect(defaultFetcher('https://example.com/search', controller.signal))
        .rejects.toThrow('检索已取消')
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('文本输出', () => {
  test('Given 有结果 When 格式化 Then 逐条编号并带链接', () => {
    const text = formatWebSearchOutcome({
      ok: true,
      query: 'q',
      resultCount: 1,
      results: [{ title: '标题', url: 'https://example.com', snippet: '摘要' }],
    })

    expect(text).toContain('1. 标题')
    expect(text).toContain('https://example.com')
    expect(text).toContain('摘要')
  })

  test('Given 失败 When 格式化 Then 拼上替代建议', () => {
    expect(formatWebSearchOutcome({ ok: false, query: 'q', error: '失败', hint: '换浏览器' }))
      .toBe('失败\n换浏览器')
  })
})
