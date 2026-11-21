import { afterAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchPageAsMarkdown, formatWebFetchOutcome, normalizeFetchUrl } from './web-fetch-service'

let server: Server | undefined
let baseUrl = ''

async function ensureServer(): Promise<string> {
  if (baseUrl) return baseUrl
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname === '/html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<html><head><title>示例页面</title></head><body>
        <nav>导航</nav>
        <article><h1>正文标题</h1><p>这是正文段落，包含 <a href="https://example.com">链接</a>。</p></article>
      </body></html>`)
      return
    }
    if (url.pathname === '/plain') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('纯文本内容\n第二行')
      return
    }
    if (url.pathname === '/binary') {
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end('%PDF-1.4')
      return
    }
    if (url.pathname === '/empty') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><body><script>x</script></body></html>')
      return
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/html' })
      response.end()
      return
    }
    if (url.pathname === '/loop') {
      response.writeHead(302, { location: '/loop' })
      response.end()
      return
    }
    if (url.pathname === '/to-ftp') {
      response.writeHead(302, { location: 'ftp://example.com/x' })
      response.end()
      return
    }
    if (url.pathname === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(200_000))
      return
    }
    response.writeHead(404, { 'content-type': 'text/html' })
    response.end('<html><body>not found</body></html>')
  })

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  return baseUrl
}

afterAll(async () => {
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
})

describe('URL 校验', () => {
  test('Given http(s) When 归一化 Then 通过', () => {
    expect(normalizeFetchUrl('https://example.com/a?b=1')?.toString()).toBe('https://example.com/a?b=1')
    expect(normalizeFetchUrl('http://example.com')?.toString()).toBe('http://example.com/')
  })

  test('Given 非 http 或带凭据 When 归一化 Then 拒绝', () => {
    expect(normalizeFetchUrl('ftp://example.com')).toBeNull()
    expect(normalizeFetchUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeFetchUrl('https://user:pass@example.com')).toBeNull()
    expect(normalizeFetchUrl('not a url')).toBeNull()
  })
})

describe('抓取与转换', () => {
  test('Given HTML 页面 When 抓取 Then 返回正文 Markdown 与标题', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/html`)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.title).toBe('示例页面')
      expect(outcome.content).toContain('# 正文标题')
      expect(outcome.content).toContain('[链接](https://example.com)')
      // 导航被移除。
      expect(outcome.content).not.toContain('导航')
    }
  })

  test('Given 纯文本 When 抓取 Then 原样返回', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/plain`)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.content).toBe('纯文本内容\n第二行')
  })

  test('Given 重定向 When 抓取 Then 跟随到最终页面', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/redirect`)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.url).toBe(`${base}/html`)
  })

  test('Given 重定向成环 When 抓取 Then 报可读错误', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/loop`)

    expect(outcome.ok).toBe(false)
  })

  test('Given 重定向到非 http 协议 When 抓取 Then 拒绝', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/to-ftp`)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('不支持的地址')
  })

  test('Given 404 When 抓取 Then 提示链接可能失效', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/missing`)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.error).toContain('404')
    }
  })

  test('Given 二进制内容 When 抓取 Then 提示不是可读文本', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/binary`)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('application/pdf')
  })

  test('Given 页面只有脚本 When 抓取 Then 提示无法提取正文', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/empty`)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('无法提取正文')
  })

  test('Given 正文超过上限 When 设定 maxChars Then 截断并标注', async () => {
    const base = await ensureServer()
    const outcome = await fetchPageAsMarkdown(`${base}/big`, { maxChars: 500 })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.truncated).toBe(true)
      expect(outcome.content).toContain('已截断')
    }
  })

  test('Given 已取消的 signal When 抓取 Then 返回取消错误', async () => {
    const base = await ensureServer()
    const controller = new AbortController()
    controller.abort()

    const outcome = await fetchPageAsMarkdown(`${base}/html`, { signal: controller.signal })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('取消')
  })

  test('Given 非法 URL When 抓取 Then 直接拒绝', async () => {
    const outcome = await fetchPageAsMarkdown('ftp://example.com/x')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('http(s)')
  })
})

describe('输出格式', () => {
  test('Given 成功 When 格式化 Then 带标题与来源', () => {
    const text = formatWebFetchOutcome({
      ok: true,
      url: 'https://example.com/a',
      title: '标题',
      content: '正文',
      status: 200,
    })

    expect(text).toContain('# 标题')
    expect(text).toContain('来源：https://example.com/a')
    expect(text).toContain('正文')
  })

  test('Given 失败 When 格式化 Then 只返回错误文案', () => {
    expect(formatWebFetchOutcome({ ok: false, url: 'https://x', error: '抓取失败' })).toBe('抓取失败')
  })
})
