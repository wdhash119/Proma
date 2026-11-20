/**
 * 聊天 Markdown 顶层分块器。
 *
 * 只负责把 Markdown 切成「顶层块」，不负责渲染。每个块仍由 react-markdown
 * 用同一套插件与组件渲染，因此链接、文件 chip、表格、代码高亮的语义与
 * 整篇渲染完全一致；收益在于流式输出时只有尾块需要重新解析与协调。
 */

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export interface ChatMarkdownBlock {
  /** React key。流式期间未完成的尾块使用稳定 key，避免反复 remount。 */
  id: string
  /** 该块的原始 Markdown 片段 */
  source: string
  /** 顶层 mdast 节点类型，用于调试与测试断言 */
  type: string
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/** 简单字符串散列，仅用于生成稳定的块 key。 */
function hashContent(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * 把 Markdown 源码拆成顶层块。
 *
 * 依赖 mdast 节点的 offset 信息切回原始源码，避免重新序列化导致格式漂移。
 * 无 offset 的节点（理论上只出现在合成文档中）会被跳过。
 */
export function parseChatMarkdownBlocks(source: string): ChatMarkdownBlock[] {
  if (source.length === 0 || source.trim().length === 0) return []

  const tree = markdownProcessor.parse(source)
  const blocks: ChatMarkdownBlock[] = []
  for (const node of tree.children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (typeof start !== 'number' || typeof end !== 'number') continue
    const slice = source.slice(start, end).trim()
    if (slice.length === 0) continue
    blocks.push({ id: '', source: slice, type: node.type })
  }
  return blocks
}

/**
 * 复用上一帧的块 key。
 *
 * - 内容未变的前缀块沿用原 id，配合 React.memo 跳过重新渲染；
 * - 流式输出时最后一个块固定使用 tail id，避免每个 chunk 都 remount；
 * - 其余变化块按内容散列生成 id。
 */
export function reconcileChatMarkdownBlocks(
  previous: readonly ChatMarkdownBlock[],
  next: readonly ChatMarkdownBlock[],
  isStreaming: boolean,
): ChatMarkdownBlock[] {
  const lastIndex = next.length - 1
  return next.map((block, index) => {
    const previousBlock = previous[index]
    if (previousBlock && previousBlock.id && previousBlock.source === block.source && previousBlock.type === block.type) {
      // 内容未变（包括已完成的尾块）：直接沿用 key，避免重建代码高亮等组件状态。
      return { ...block, id: previousBlock.id }
    }
    // 流式尾块的 key 带索引：既保持跨 chunk 稳定，又不会与更早的已完成块冲突。
    if (isStreaming && index === lastIndex) {
      return { ...block, id: `tail:${index}:${block.type}` }
    }
    return { ...block, id: `${index}:${block.type}:${hashContent(block.source)}` }
  })
}
