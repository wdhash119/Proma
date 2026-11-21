import { describe, expect, test } from 'bun:test'
import { decodeHtmlEntities } from './html-entities'
import { htmlToMarkdown } from './html-to-markdown'
import { parseDuckDuckGoHtml, searchWeb } from './web-search-service'

describe('HTML 实体解码', () => {
  test('Given 命名与合法数值实体 When 解码 Then 得到对应字符', () => {
    expect(decodeHtmlEntities('A &amp; B &lt; C &nbsp; D')).toBe('A & B < C   D')
    expect(decodeHtmlEntities('&#65;&#x41;&#x4e2d;')).toBe('AA中')
  })

  test('Given 超过 Unicode 上限的数值实体 When 解码 Then 原样保留且不抛错', () => {
    expect(() => decodeHtmlEntities('&#x110000;')).not.toThrow()
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;')
    expect(decodeHtmlEntities('&#1114112;')).toBe('&#1114112;')
  })
})

describe('消费方对非法实体的容错', () => {
  test('Given HTML 含非法数值实体 When 转 Markdown Then 保留原文并继续转换', () => {
    const markdown = htmlToMarkdown('<p>前 &#x110000; 后</p>')

    expect(markdown).toContain('&#x110000;')
    expect(markdown).toContain('前')
    expect(markdown).toContain('后')
  })

  test('Given 搜索结果标题含非法实体 When 解析 Then 不抛错且保留该结果', () => {
    const html = `
      <div class="result results_links">
        <div class="links_main result__body">
          <h2 class="result__title"><a href="https://example.com/x">标题 &#x110000; 结尾</a></h2>
        </div>
      </div>`

    const items = parseDuckDuckGoHtml(html, 10)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toContain('&#x110000;')
  })

  test('Given 检索页含非法实体 When 检索 Then 仍返回成功结果', async () => {
    const outcome = await searchWeb('entity', {
      fetcher: async () => `
        <div class="result results_links">
          <div class="links_main result__body">
            <h2 class="result__title"><a href="https://example.com/y">Y &#1114112;</a></h2>
          </div>
        </div>`,
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.resultCount).toBe(1)
  })
})
