import type { ChatMarkdownBlock } from './chat-markdown-blocks'

/**
 * 流式尾块稳定化。
 *
 * 问题：流式输出时最后一个块还没写完，react-markdown 却已经按「完整块」解析它。
 * 于是 `-`、`#`、`|`、`$$` 刚出现时，整块会从 `<p>` 立刻换成
 * `<ul>`/`<h1>`/`<table>`/math，字号、行高、缩进和可用宽度同时改变，
 * 用户已经读过的那几行当场重新断行；块高还会跳上百 px，叠上 StickToBottom 追底
 * 就成了「文字在闪、断句在变」。
 *
 * 做法：结构尚未定型的尾块先按纯文本渲染（`type: 'text'`，不解析 markdown），
 * 等它被空行或后续块冻结、或自身已经闭合（闭合 `$$`、单行 ATX 标题）后，
 * 才换成真实 markdown 元素。每块因此只切换一次渲染形态，且切换时它已不再增长。
 *
 * 段落与纯文本尾块不受影响：它们本来就不是结构化盒子，仍走 react-markdown，
 * 所以 `**粗体**`、`` `代码` ``、链接这些行内语义依旧实时生效。
 */

/** 会从 `<p>` 跳到别的元素、因而会改变断行的块类型 */
const STRUCTURAL_BLOCK_TYPES = new Set([
  'heading',
  'list',
  'table',
  'blockquote',
  'math',
  'html',
  'thematicBreak',
  // 故意不含 'code'：围栏一旦出现就固定为 code，不会来回翻转（实测 paragraph → code
  // 只跃迁一次，之后整段增长形态不变），所以降级只能把跃迁推后，
  // 代价却是代码在闭合前没有语法高亮与等宽展示。代码块即时渲染收益更大。
  // 故意不含 'document'：那是引用式链接/脚注 definition 语义必需的整篇兜底，
  // 降级会把整条消息变成裸文本。它命中后整条消息本来就只有一块，
  // 宽度与字号不变，重新解析不会移动断点，只会重建 DOM。
])

/** 围栏代码块是否已经出现闭合围栏 */
function hasClosedFence(source: string): boolean {
  const lines = source.split('\n')
  let open: string | null = null
  for (const line of lines) {
    const match = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (!match) continue
    const marker = match[1] as string
    if (!open) {
      open = marker
      continue
    }
    // CommonMark：闭合围栏长度必须不小于开启围栏，且行内无其他内容
    if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) return true
  }
  return false
}

/** 数学块（`$$`）是否已经闭合 */
function hasClosedMathBlock(source: string): boolean {
  const lines = source.split('\n')
  let open = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('$$')) continue
    const rest = trimmed.slice(2)
    if (!open) {
      // `$$ 公式 $$` 同行闭合；否则一律视为开启，含 `$$ 公式` 这种开启行带内容的写法
      // （remark-math 会把它解析成 math 块，随后独立一行的 `$$` 即闭合）。
      if (rest.trim().length > 0 && rest.trimEnd().endsWith('$$')) return true
      open = true
      continue
    }
    // 已在块内：遇到 `$$`（可为行尾闭合）即结束
    if (trimmed === '$$' || trimmed.startsWith('$$')) return true
  }
  return false
}

/**
 * 尾块是否已经定型：定型后可以按真实结构渲染，之后不会再被改写。
 *
 * 目前 `'code'` 不在降级集合里，这里的 `case 'code'` 保留为围栏闭合语义的单一出口，
 * 便于以后需要降级代码块时直接加回集合。
 *
 * @param source 尾块源码
 * @param type 解析出的块类型
 */
export function isChatMarkdownTailSettled(source: string, type: string): boolean {
  switch (type) {
    // ATX 标题到行尾就结束了；只要尾块里还有第二行，标题本身已经冻结。
    case 'heading':
      return source.includes('\n')
    case 'code':
      return hasClosedFence(source)
    case 'math':
      return hasClosedMathBlock(source)
    // `---` 一旦被判成分隔线就是终态。
    case 'thematicBreak':
      return true
    // 列表、表格、引用、整篇文档兜底都会继续吸收后面的行。
    case 'list':
    case 'table':
    case 'blockquote':
    case 'html':
      return false
    default:
      return true
  }
}

/**
 * 把尚未定型的流式尾块降级成纯文本块。
 *
 * 只改最后一个块：前面的块已经由 reconcile 冻结，形态不会变。
 *
 * @param blocks 当前帧解析出的块序列
 */
export function stabilizeChatMarkdownStreamTail(
  blocks: readonly ChatMarkdownBlock[],
): readonly ChatMarkdownBlock[] {
  if (blocks.length === 0) return blocks
  const tail = blocks[blocks.length - 1] as ChatMarkdownBlock
  if (!tail) return blocks
  if (!STRUCTURAL_BLOCK_TYPES.has(tail.type)) return blocks
  if (isChatMarkdownTailSettled(tail.source, tail.type)) return blocks
  const next = blocks.slice(0, -1)
  next.push({ ...tail, type: 'text' })
  return next
}
