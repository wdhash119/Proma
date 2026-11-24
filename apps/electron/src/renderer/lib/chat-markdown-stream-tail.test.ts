import { describe, expect, test } from 'bun:test'
import { parseChatMarkdownBlocks } from './chat-markdown-blocks'
import { isChatMarkdownTailSettled, stabilizeChatMarkdownStreamTail } from './chat-markdown-stream-tail'

/** 解析后再做流式尾块稳定化，返回 [类型序列, 尾块类型]。 */
function streamTypes(source: string): { types: string[]; tailType: string } {
  const blocks = stabilizeChatMarkdownStreamTail(parseChatMarkdownBlocks(source))
  const types = blocks.map((block) => block.type)
  return { types, tailType: types[types.length - 1] ?? '' }
}

describe('流式尾块降级', () => {
  test('Given 段落尾块 When 稳定化 Then 不降级，行内语义仍由 markdown 解析', () => {
    expect(streamTypes('先把结论**讲清楚**，还带了 `代码`').tailType).toBe('paragraph')
  })

  test('Given 列表尾块未冻结 When 稳定化 Then 先按纯文本渲染', () => {
    expect(streamTypes('- 第一条：70px 近底窗口').tailType).toBe('text')
    expect(streamTypes('- 第一条\n- 第二条').tailType).toBe('text')
  })

  test('Given 列表已被后续块冻结 When 稳定化 Then 列表保持原类型', () => {
    // 列表不再是尾块 → 不再降级，恢复成真实 list 结构
    const { types } = streamTypes('- 第一条\n- 第二条\n\n收尾段落')
    expect(types).toEqual(['list', 'paragraph'])
  })

  test('Given 标题尾块仍在输入 When 稳定化 Then 先按纯文本渲染，避免空标题占位与字号跳变', () => {
    expect(streamTypes('#').tailType).toBe('text')
    expect(streamTypes('# 会话标题').tailType).toBe('text')
  })

  test('Given 标题已有后续行 When 稳定化 Then 标题保持 heading', () => {
    // 尾块是「标题 + 换行」时标题本身已冻结
    expect(isChatMarkdownTailSettled('# 会话标题\n正文起步', 'heading')).toBe(true)
    expect(isChatMarkdownTailSettled('# 会话标题', 'heading')).toBe(false)
  })

  test('Given 围栏未闭合 When 稳定化 Then 代码块不降级，仍即时渲染 code', () => {
    const { types } = streamTypes('说明段落\n\n```ts\nconst a = 1')
    expect(types).toEqual(['paragraph', 'code'])
  })

  test('Given 围栏已闭合 When 稳定化 Then 保持 code', () => {
    const { types } = streamTypes('说明段落\n\n```ts\nconst a = 1\n```')
    expect(types).toEqual(['paragraph', 'code'])
  })

  test('Given 波浪号围栏 When 判定闭合 Then 长度与字符都要匹配', () => {
    expect(isChatMarkdownTailSettled('~~~\ncode\n~~~', 'code')).toBe(true)
    expect(isChatMarkdownTailSettled('~~~~\ncode\n~~~', 'code')).toBe(false)
    expect(isChatMarkdownTailSettled('```js\ncode\n``` ', 'code')).toBe(true)
  })

  test('Given 数学块 When 判定闭合 Then 同行与独立闭合都算已定型', () => {
    expect(isChatMarkdownTailSettled('$$\n\\frac{a}{b}\n$$', 'math')).toBe(true)
    expect(isChatMarkdownTailSettled('$$E = mc^2$$', 'math')).toBe(true)
    expect(isChatMarkdownTailSettled('$$\n\\frac{a}{b}', 'math')).toBe(false)
  })

  test('Given 开启行带内容的数学块 When 判定闭合 Then 独立闭合行也算已定型', () => {
    // remark-math 把 `$$ x` 解析成 math 块的开启行；随后独立一行 `$$` 即闭合。
    expect(isChatMarkdownTailSettled('$$ x\n$$', 'math')).toBe(true)
    expect(isChatMarkdownTailSettled('$$ x\ny', 'math')).toBe(false)
  })

  test('Given 表格尾块 When 稳定化 Then 先按纯文本渲染', () => {
    const { types } = streamTypes('结论如下\n\n| 指标 | 实测 |\n| --- | --- |\n| 块签名变化 | 26/32 帧 |')
    expect(types).toEqual(['paragraph', 'text'])
  })

  test('Given 引用尾块 When 稳定化 Then 先按纯文本渲染', () => {
    expect(streamTypes('> 需要应用层显式管状态').tailType).toBe('text')
  })

  test('Given 整篇文档兜底 When 稳定化 Then 不降级，保留引用式链接语义', () => {
    const source = '结论见 [文档][docs]。\n\n[docs]: https://proma.cool/docs'
    const parsed = parseChatMarkdownBlocks(source)
    expect(parsed.map((b) => b.type)).toEqual(['document'])
    expect(stabilizeChatMarkdownStreamTail(parsed).map((b) => b.type)).toEqual(['document'])
  })

  test('Given 分隔线尾块 When 稳定化 Then 保持原类型（已是终态）', () => {
    expect(isChatMarkdownTailSettled('---', 'thematicBreak')).toBe(true)
    expect(streamTypes('段落\n\n---').types).toEqual(['paragraph', 'thematicBreak'])
  })
})

describe('流式尾块稳定化的边界', () => {
  test('Given 空块序列 When 稳定化 Then 返回同一引用', () => {
    const empty = parseChatMarkdownBlocks('')
    expect(stabilizeChatMarkdownStreamTail(empty)).toBe(empty)
  })

  test('Given 多个块 When 稳定化 Then 只改最后一个块，前面块引用不变', () => {
    const parsed = parseChatMarkdownBlocks('第一段\n\n- 列表项')
    const stabilized = stabilizeChatMarkdownStreamTail(parsed)
    expect(stabilized[0]).toBe(parsed[0])
    expect(stabilized[1]).not.toBe(parsed[1])
    expect(stabilized[1]?.type).toBe('text')
    expect(stabilized[1]?.source).toBe(parsed[1]?.source)
  })

  test('Given 逐字流式序列 When 每帧稳定化 Then 尾块类型只在定型时变化一次', () => {
    const full = '说明段落。\n\n- 第一项\n- 第二项\n\n收尾。'
    const tailTypes: string[] = []
    for (let i = 1; i <= full.length; i++) {
      tailTypes.push(streamTypes(full.slice(0, i)).tailType)
    }
    const transitions: string[] = []
    for (let i = 1; i < tailTypes.length; i++) {
      if (tailTypes[i] !== tailTypes[i - 1]) transitions.push(`${tailTypes[i - 1]}→${tailTypes[i]}`)
    }
    // 段落（行内语义实时）→ 列表降级为纯文本→ 列表被冻结后尾块换成新段落。
    // 全程 list 不作为尾块渲染，因此不会出现「已上屏行先段落再列表」的结构跃迁。
    expect(transitions).toEqual(['paragraph→text', 'text→paragraph'])
  })
})
