import { describe, expect, test } from 'bun:test'
import { extractHtmlTitle, extractMainHtml, htmlToMarkdown } from './html-to-markdown'

describe('正文范围与标题', () => {
  test('Given 页面有 article When 取正文 Then 只保留 article 内容', () => {
    const html = `
      <html><body>
        <nav>导航</nav>
        <article><h1>标题</h1><p>${'正文内容'.repeat(60)}</p></article>
        <footer>页脚</footer>
      </body></html>`

    const main = extractMainHtml(html)
    expect(main).toContain('正文内容')
    expect(main).not.toContain('导航')
  })

  test('Given article 太短 When 取正文 Then 回退到 body', () => {
    const html = '<html><body><article>短</article><p>' + 'x'.repeat(300) + '</p></body></html>'
    expect(extractMainHtml(html)).toContain('x'.repeat(300))
  })

  test('Given 有 title When 提取 Then 解码实体并去标签', () => {
    expect(extractHtmlTitle('<html><head><title> A &amp; B </title></head></html>')).toBe('A & B')
    expect(extractHtmlTitle('<html><head></head></html>')).toBeNull()
  })
})

describe('结构转换', () => {
  test('Given 标题与段落 When 转换 Then 生成对应 Markdown', () => {
    const markdown = htmlToMarkdown('<h1>一级</h1><h3>三级</h3><p>段落一</p><p>段落二</p>')

    expect(markdown).toContain('# 一级')
    expect(markdown).toContain('### 三级')
    expect(markdown).toContain('段落一')
    expect(markdown).toContain('段落二')
    // 段落之间保留空行。
    expect(markdown).toContain('段落一\n\n段落二')
  })

  test('Given 无序列表 When 转换 Then 每项一行短横线', () => {
    const markdown = htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>')
    expect(markdown).toBe('- 甲\n- 乙')
  })

  test('Given 链接与强调 When 转换 Then 保留可用 Markdown 语法', () => {
    const markdown = htmlToMarkdown('<p>见 <a href="https://example.com/a">文档</a>，<strong>重要</strong>，<em>注意</em></p>')

    expect(markdown).toContain('[文档](https://example.com/a)')
    expect(markdown).toContain('**重要**')
    expect(markdown).toContain('*注意*')
  })

  test('Given javascript 链接 When 转换 Then 只保留文本', () => {
    const markdown = htmlToMarkdown('<p><a href="javascript:alert(1)">点我</a></p>')
    expect(markdown).toBe('点我')
  })

  test('Given 代码块 When 转换 Then 生成带语言标注的围栏', () => {
    const markdown = htmlToMarkdown('<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>')

    expect(markdown).toContain('```ts')
    expect(markdown).toContain('const a = 1 < 2')
    expect(markdown).toContain('```')
  })

  test('Given 引用 When 转换 Then 每行加 > 前缀', () => {
    const markdown = htmlToMarkdown('<blockquote>引用第一句<br>引用第二句</blockquote>')
    expect(markdown).toBe('> 引用第一句\n> 引用第二句')
  })

  test('Given 图片 When 转换 Then 生成 Markdown 图片语法', () => {
    const markdown = htmlToMarkdown('<p><img src="https://example.com/a.png" alt="示意图"></p>')
    expect(markdown).toBe('![示意图](https://example.com/a.png)')
  })

  test('Given 分割线 When 转换 Then 生成 ---', () => {
    expect(htmlToMarkdown('<p>上</p><hr><p>下</p>')).toContain('---')
  })
})

describe('内容清理', () => {
  test('Given script/style/noscript When 转换 Then 内容被整体丢弃', () => {
    const markdown = htmlToMarkdown(`
      <div>
        <script>console.log('secret')</script>
        <style>.a{color:red}</style>
        <noscript>请开启 JS</noscript>
        <p>真正的正文</p>
      </div>`)

    expect(markdown).toBe('真正的正文')
    expect(markdown).not.toContain('secret')
    expect(markdown).not.toContain('color:red')
    expect(markdown).not.toContain('请开启 JS')
  })

  test('Given HTML 注释 When 转换 Then 被移除', () => {
    expect(htmlToMarkdown('<p>前<!-- 隐藏 -->后</p>')).toBe('前后')
  })

  test('Given 常见实体 When 转换 Then 正确解码', () => {
    expect(htmlToMarkdown('<p>&amp; &lt; &gt; &quot; &nbsp;&#39;&#x4e2d;</p>')).toBe('& < > "  \'中')
  })

  test('Given 表格结构 When 转换 Then 退化为竖线分隔的可读文本', () => {
    const markdown = htmlToMarkdown('<table><tr><td>甲</td><td>乙</td></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(markdown).toContain('甲')
    expect(markdown).toContain('乙')
    expect(markdown).toContain('|')
  })

  test('Given 连续空行 When 转换 Then 折叠为最多一个空行', () => {
    const markdown = htmlToMarkdown('<p>上</p><div></div><div></div><p>下</p>')
    expect(markdown).not.toContain('\n\n\n')
  })
})

describe('截断', () => {
  test('Given 超长正文 When 设定上限 Then 截断并标注', () => {
    const markdown = htmlToMarkdown(`<p>${'x'.repeat(500)}</p>`, { maxChars: 100 })

    expect(markdown.length).toBeLessThan(200)
    expect(markdown).toContain('已截断')
  })

  test('Given 正文在上限内 When 转换 Then 不添加截断标记', () => {
    expect(htmlToMarkdown('<p>短</p>', { maxChars: 100 })).toBe('短')
  })

  test('Given 空输入 When 转换 Then 返回空串', () => {
    expect(htmlToMarkdown('')).toBe('')
  })
})
