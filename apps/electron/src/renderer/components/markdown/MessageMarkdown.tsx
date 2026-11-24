/**
 * MessageMarkdown — 消息正文与推理内容的增量 Markdown 渲染器。
 *
 * 与整篇 react-markdown 渲染的区别：先把源码切成顶层块，再让每个块独立渲染，
 * 流式输出时只有尾块会重新解析。尾块若结构尚未定型（`-`、`#`、`|`、`$$` 刚出现，
 * 代码块除外）会先降级成纯文本，等它被空行冻结或自身已闭合后才换成真 markdown 元素，
 * 以免已上屏的行在输入中途换盒子、重新断行。块的渲染仍复用调用方传入的插件、
 * 组件与 urlTransform，因此行为与整篇渲染保持一致。
 */

import * as React from 'react'
import Markdown, { type Components, type UrlTransform } from 'react-markdown'
import type { PluggableList } from 'unified'
import {
  parseMessageMarkdownBlocks,
  reconcileMessageMarkdownBlocks,
  type MessageMarkdownBlock,
} from '@/lib/message-markdown-blocks'
import { stabilizeMessageMarkdownStreamTail } from '@/lib/message-markdown-stream-tail'

interface MessageMarkdownProps {
  /** Markdown 源码 */
  source: string
  /** 已归一化的 remark 插件（稳定引用） */
  remarkPlugins?: PluggableList
  /** 已归一化的 rehype 插件（稳定引用） */
  rehypePlugins?: PluggableList
  /** 自定义 URL 清洗，需与整篇渲染保持一致 */
  urlTransform?: UrlTransform
  /** 自定义渲染组件映射 */
  components?: Components
  /** 是否仍在流式输出；true 时未定型的尾块降级为纯文本，并保持稳定 key */
  isStreaming?: boolean
}

interface MessageMarkdownBlockViewProps {
  block: MessageMarkdownBlock
  remarkPlugins?: PluggableList
  rehypePlugins?: PluggableList
  urlTransform?: UrlTransform
  components?: Components
}

/**
 * 单块渲染。上一层用 React.memo 冻结未变化的块，流式期间不会重复解析历史内容。
 *
 * `type === 'text'` 是流式尾块的降级形态：结构尚未定型（`-`、`#`、`|`、围栏、`$$`
 * 刚出现）的尾块先按纯文本输出，不解析 markdown，避免已上屏的行立刻换盒子重新断行。
 */
const MessageMarkdownBlockView = React.memo(function MessageMarkdownBlockView({
  block,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  components,
}: MessageMarkdownBlockViewProps): React.ReactElement {
  if (block.type === 'text') {
    return <p className="whitespace-pre-wrap break-words">{block.source}</p>
  }
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {block.source}
    </Markdown>
  )
})

export const MessageMarkdown = React.memo(function MessageMarkdown({
  source,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  components,
  isStreaming = false,
}: MessageMarkdownProps): React.ReactElement {
  const previousBlocksRef = React.useRef<readonly MessageMarkdownBlock[]>([])

  const blocks = React.useMemo(() => {
    const parsed = parseMessageMarkdownBlocks(source)
    // 流式中先把未定型的尾块降级成纯文本，定型（被空行冻结或自身已闭合）后才换成真元素。
    const stabilized = isStreaming ? stabilizeMessageMarkdownStreamTail(parsed) : parsed
    const reconciled = reconcileMessageMarkdownBlocks(previousBlocksRef.current, stabilized, isStreaming)
    previousBlocksRef.current = reconciled
    return reconciled
  }, [source, isStreaming])

  return (
    <>
      {blocks.map((block) => (
        <MessageMarkdownBlockView
          key={block.id}
          block={block}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
          components={components}
        />
      ))}
    </>
  )
})
