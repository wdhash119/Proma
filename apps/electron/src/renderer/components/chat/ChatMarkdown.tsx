/**
 * ChatMarkdown — 聊天与推理内容的增量 Markdown 渲染器。
 *
 * 与整篇 react-markdown 渲染的区别：先把源码切成顶层块，再让每个块独立渲染，
 * 流式输出时只有尾块会重新解析。块的渲染仍复用调用方传入的插件、组件与
 * urlTransform，因此行为与整篇渲染保持一致。
 */

import * as React from 'react'
import Markdown, { type Components, type UrlTransform } from 'react-markdown'
import type { PluggableList } from 'unified'
import {
  parseChatMarkdownBlocks,
  reconcileChatMarkdownBlocks,
  type ChatMarkdownBlock,
} from '@/lib/chat-markdown-blocks'

export interface ChatMarkdownProps {
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
  /** 是否仍在流式输出；true 时尾块保持稳定 key */
  isStreaming?: boolean
}

interface ChatMarkdownBlockViewProps {
  block: ChatMarkdownBlock
  remarkPlugins?: PluggableList
  rehypePlugins?: PluggableList
  urlTransform?: UrlTransform
  components?: Components
}

/**
 * 单块渲染。上一层用 React.memo 冻结未变化的块，流式期间不会重复解析历史内容。
 */
const ChatMarkdownBlockView = React.memo(function ChatMarkdownBlockView({
  block,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  components,
}: ChatMarkdownBlockViewProps): React.ReactElement {
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

export const ChatMarkdown = React.memo(function ChatMarkdown({
  source,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  components,
  isStreaming = false,
}: ChatMarkdownProps): React.ReactElement {
  const previousBlocksRef = React.useRef<readonly ChatMarkdownBlock[]>([])

  const blocks = React.useMemo(() => {
    const parsed = parseChatMarkdownBlocks(source)
    const reconciled = reconcileChatMarkdownBlocks(previousBlocksRef.current, parsed, isStreaming)
    previousBlocksRef.current = reconciled
    return reconciled
  }, [source, isStreaming])

  return (
    <>
      {blocks.map((block) => (
        <ChatMarkdownBlockView
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
