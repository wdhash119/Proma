import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseMessageMarkdownBlocks, reconcileMessageMarkdownBlocks } from './message-markdown-blocks'

describe('聊天 Markdown 顶层分块', () => {
  test('Given 空内容 When 解析 Then 不产生任何块', () => {
    expect(parseMessageMarkdownBlocks('')).toEqual([])
    expect(parseMessageMarkdownBlocks('   \n\n  ')).toEqual([])
  })

  test('Given 两段文本 When 解析 Then 按空行拆成两个段落块', () => {
    const blocks = parseMessageMarkdownBlocks('第一段\n\n第二段')
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph'])
    expect(blocks.map((block) => block.source)).toEqual(['第一段', '第二段'])
  })

  test('Given 代码围栏 When 解析 Then 保留完整源码且不被拆分', () => {
    const source = '说明文字\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n结尾'
    const blocks = parseMessageMarkdownBlocks(source)
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'code', 'paragraph'])
    expect(blocks[1]?.source).toContain('const a = 1')
    expect(blocks[1]?.source.startsWith('```ts')).toBe(true)
  })

  test('Given Mermaid 围栏 When 解析 Then 仍是代码块并保留语言标记', () => {
    const blocks = parseMessageMarkdownBlocks('```mermaid\ngraph TD\nA-->B\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('code')
    expect(blocks[0]?.source).toContain('graph TD')
  })

  test('Given 块级数学 When 解析 Then 生成独立的 math 块', () => {
    const blocks = parseMessageMarkdownBlocks('前文\n\n$$\nE = mc^2\n$$\n\n后文')
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'math', 'paragraph'])
    expect(blocks[1]?.source).toContain('E = mc^2')
  })

  test('Given GFM 表格 When 解析 Then 表格自成一块', () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const blocks = parseMessageMarkdownBlocks(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('table')
  })

  test('Given 列表 When 解析 Then 整个列表是一个块', () => {
    const blocks = parseMessageMarkdownBlocks('- 一\n- 二\n- 三')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('list')
  })

  test('Given 未闭合的代码围栏 When 解析 Then 与 react-markdown 一致，按代码块处理', () => {
    // CommonMark 允许围栏在文档结尾自行结束；这与整篇 react-markdown 的解析结果一致，
    // 因此流式过程中不会出现「先当段落、关闭后突变」的语义偏差。
    const blocks = parseMessageMarkdownBlocks('正在写代码\n\n```ts\nconst a = 1')
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'code'])
  })
})

describe('聊天 Markdown 块 key 复用', () => {
  test('Given 追加新段落 When 流式复用 Then 前缀块保持原 key，仅尾块使用 tail key', () => {
    const previous = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段'), true)
    const next = reconcileMessageMarkdownBlocks(previous, parseMessageMarkdownBlocks('第一段\n\n第二段'), true)

    expect(next[0]?.id).toBe(previous[0]?.id)
    expect(next[1]?.id).toBe('tail:1:paragraph')
  })

  test('Given 尾块内容增长 When 流式复用 Then tail key 保持不变', () => {
    const first = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段'), true)
    const second = reconcileMessageMarkdownBlocks(first, parseMessageMarkdownBlocks('第一段继续'), true)

    expect(first[0]?.id).toBe('tail:0:paragraph')
    expect(second[0]?.id).toBe('tail:0:paragraph')
  })

  test('Given 流式结束 When 复用 Then 内容相同的块保持原 key 且 key 唯一', () => {
    const streaming = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段\n\n第二段'), true)
    const settled = reconcileMessageMarkdownBlocks(streaming, parseMessageMarkdownBlocks('第一段\n\n第二段'), false)

    expect(settled[0]?.id).toBe(streaming[0]?.id)
    expect(settled[1]?.id).toBe(streaming[1]?.id)
    const ids = settled.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('Given 流式结束后新增段落 When 复用 Then 不会出现重复 key', () => {
    const streaming = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段\n\n第二段'), true)
    const appended = reconcileMessageMarkdownBlocks(streaming, parseMessageMarkdownBlocks('第一段\n\n第二段\n\n第三段'), true)

    const ids = appended.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[2]).toBe('tail:2:paragraph')
  })

  test('Given 内容变化 When 非流式复用 Then 生成新 key 触发重渲染', () => {
    const previous = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段'), false)
    const next = reconcileMessageMarkdownBlocks(previous, parseMessageMarkdownBlocks('改写后的段落'), false)

    expect(next[0]?.id).not.toBe(previous[0]?.id)
  })
})

/** 用真实 react-markdown 渲染单个块，验证分块后语义未变（无需 DOM）。 */function renderMarkdown(source: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { remarkPlugins: [remarkGfm] }, source))
}

describe('聊天 Markdown 块语义', () => {
  test('Given 引用式链接跨段落的定义 When 解析并渲染 Then 链接可解析而非字面量', () => {
    const source = '正文引用 [文档][ref]\n\n[ref]: https://example.com/docs\n'
    const blocks = parseMessageMarkdownBlocks(source)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('document')
    const html = renderMarkdown(blocks[0]?.source ?? '')
    expect(html).toContain('<a href="https://example.com/docs">文档</a>')
    expect(html).not.toContain('[ref]')
  })

  test('Given 脚注引用与脚注定义 When 解析 Then 整篇作为单块，避免脚注跨块失效', () => {
    const blocks = parseMessageMarkdownBlocks('正文[^1]\n\n[^1]: 脚注内容')

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('document')
    expect(renderMarkdown(blocks[0]?.source ?? '')).toContain('脚注内容')
  })

  test('Given 缩进代码块 When 解析并渲染 Then 仍是 code 且保留首行四空格缩进', () => {
    const source = '前文\n\n    const x = 1\n    const y = 2\n\n后文'
    const blocks = parseMessageMarkdownBlocks(source)

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'code', 'paragraph'])
    expect(blocks[1]?.source.startsWith('    const x = 1')).toBe(true)
    const html = renderMarkdown(blocks[1]?.source ?? '')
    expect(html).toContain('<pre>')
    expect(html).toContain('const x = 1')
  })

  test('Given 带空行的文档 When 切块 Then 只去掉块间空白，不改变块内缩进', () => {
    const blocks = parseMessageMarkdownBlocks('\n\n第一段\n\n\n\n第二段\n\n')

    expect(blocks.map((block) => block.source)).toEqual(['第一段', '第二段'])
  })
})

describe('聊天 Markdown 未变块复用同引用', () => {
  test('Given 流式追加尾块 When 复用 Then 未变前缀块直接返回上一帧对象', () => {
    const previous = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段\n\n第二段'), true)
    const next = reconcileMessageMarkdownBlocks(previous, parseMessageMarkdownBlocks('第一段\n\n第二段继续'), true)

    expect(next[0]).toBe(previous[0]!)
    expect(next[1]).not.toBe(previous[1]!)
  })

  test('Given 流式结束且内容不变 When 复用 Then 所有块保持原对象', () => {
    const streaming = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('第一段\n\n第二段'), true)
    const settled = reconcileMessageMarkdownBlocks(streaming, parseMessageMarkdownBlocks('第一段\n\n第二段'), false)

    expect(settled[0]).toBe(streaming[0]!)
    expect(settled[1]).toBe(streaming[1]!)
  })

  test('Given 含引用定义的单块文档 When 流式追加再结束 Then 尾块 key 稳定，内容变化后生成新 key', () => {
    const first = reconcileMessageMarkdownBlocks([], parseMessageMarkdownBlocks('[a][ref]\n\n[ref]: https://example.com'), true)
    const second = reconcileMessageMarkdownBlocks(first, parseMessageMarkdownBlocks('[a][ref]\n\n[ref]: https://example.com/x'), true)

    expect(first[0]?.type).toBe('document')
    expect(second[0]?.id).toBe(first[0]?.id)

    const settled = reconcileMessageMarkdownBlocks(
      second,
      parseMessageMarkdownBlocks('[a][ref]\n\n[ref]: https://example.com/xy'),
      false,
    )
    expect(settled[0]?.id).not.toBe(second[0]?.id)
  })
})
