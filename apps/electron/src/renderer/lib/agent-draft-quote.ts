/**
 * agent-draft-quote — 把选区引用作为 chip 追加进指定 Agent 会话的输入草稿
 *
 * 背景：选区 Agent 的输入框可能尚未挂载（首次创建、右侧面板切换、Tab 未激活），
 * 此时 `insertAgentInputQuote` 事件找不到消费者。这里提供与挂载路径等价的
 * 「追加」语义：写入 markdown 草稿、HTML 草稿，并递增草稿同步版本，让输入框
 * 挂载后按现有契约恢复内容，同时不覆盖草稿里已有的文字与 chip。
 *
 * HTML 结构必须与 `RichTextInput.insertQuotedSelectionMention` 渲染结果一致，
 * 否则挂载后的 TipTap 无法把节点解析回 mention chip。
 */

import { createStore } from 'jotai'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  agentSessionDraftHtmlAtom,
  agentSessionDraftSyncVersionsAtom,
  agentSessionDraftsAtom,
} from '@/atoms/agent-atoms'
import { markdownToHtml } from '@/lib/markdown-rich-text'
import { buildQuotedSelectionLabel, serializeQuotedSelectionMention } from '@/lib/quoted-selection'

/** Jotai store 的类型以 createStore 推导，避免依赖未导出的内部类型。 */
type JotaiStore = ReturnType<typeof createStore>

/** 与 `parseQuotedSelectionMention` 共用的 marker 前缀。 */
const QUOTE_MARKER_PREFIX = '&quote:'

/** 一张草稿的两个视图；两者都必须与输入框当前契约保持一致。 */
export interface AgentDraftSnapshot {
  markdown: string
  html: string
}

/** 与 RichTextInput 中 mention 节点属性一一对应。 */
interface QuoteChip {
  /** Markdown 里承载引用 payload 的文本 marker。 */
  marker: string
  /** 可直接放入草稿 HTML 的 mention 节点。 */
  html: string
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 生成 chip 的 marker 与 HTML；非法引用（缺 text/filePath 等）返回 null，
 * 调用方据此保持草稿原样。
 */
function buildQuoteChip(quote: QuotedSelection): QuoteChip | null {
  const marker = serializeQuotedSelectionMention(quote)
  if (!marker) return null

  const payload = marker.slice(QUOTE_MARKER_PREFIX.length)
  const label = buildQuotedSelectionLabel(quote)
  // 与 insertQuotedSelectionMention 的 data-id 规则一致：历史引用用消息定位，
  // 文件/Vault 引用用 filePath + capturedAt。
  const id = quote.sourceType === 'agent-history'
    ? `${quote.messageId ?? ''}:${quote.selectionStart ?? ''}:${quote.selectionEnd ?? ''}`
    : `${quote.filePath}:${quote.capturedAt}`

  const html = [
    '<span',
    ' data-type="mention"',
    ` data-id="${escapeHtmlAttribute(id)}"`,
    ` data-label="${escapeHtmlAttribute(label)}"`,
    ' data-mention-suggestion-char="&"',
    ` data-mention-quote="${escapeHtmlAttribute(payload)}"`,
    '></span>',
  ].join('')

  return { marker, html }
}

function appendMarkerToMarkdown(markdown: string, marker: string): string {
  if (markdown.trim() === '') return marker
  // 已有文字必须原样保留；只在缺少分隔符时补一个空格。
  return /[\s]$/u.test(markdown) ? `${markdown}${marker}` : `${markdown} ${marker}`
}

function appendChipToHtml(html: string, chipHtml: string): string {
  const base = html.trim()
  if (base === '' || base === '<p></p>') return `${chipHtml} `
  // 草稿 HTML 由 TipTap getHTML 或 markdownToHtml 产出，末尾总是块级闭合；
  // chip 目标在同一行内继续输入，因此放在新的段落里更接近手动插入结果。
  if (/<\/(p|h[1-6]|ul|ol|li|blockquote|pre|table|div|details)>$/iu.test(base)) {
    return `${html}<p>${chipHtml}</p>`
  }
  return `${html}${chipHtml} `
}

function resolveDraftHtml(draft: AgentDraftSnapshot): string {
  const html = draft.html.trim()
  if (html !== '' && html !== '<p></p>') return draft.html
  return markdownToHtml(draft.markdown)
}

/**
 * 在草稿副本上追加一个引用 chip。
 *
 * - 非法引用返回 null，调用方保持原草稿不变。
 * - 已有 markdown 文字与既有 chip 全部保留。
 * - HTML 有现值时基于现值追加，否则由 markdown 转换后再追加。
 */
export function appendQuoteToAgentDraft(
  draft: Partial<AgentDraftSnapshot>,
  quote: QuotedSelection,
): AgentDraftSnapshot | null {
  const chip = buildQuoteChip(quote)
  if (!chip) return null

  const snapshot: AgentDraftSnapshot = {
    markdown: draft.markdown ?? '',
    html: draft.html ?? '',
  }

  return {
    markdown: appendMarkerToMarkdown(snapshot.markdown, chip.marker),
    html: appendChipToHtml(resolveDraftHtml(snapshot), chip.html),
  }
}

/**
 * 把引用追加到指定 session 的草稿 atoms，只影响该 session。
 *
 * 递增 `agentSessionDraftSyncVersionsAtom` 是让稍后挂载的输入框按外部同步契约
 * 覆盖编辑器内容（否则会被当作本地 echo 忽略）。
 */
export function appendQuoteToSessionDraft(
  store: JotaiStore,
  sessionId: string,
  quote: QuotedSelection,
): boolean {
  const current: AgentDraftSnapshot = {
    markdown: store.get(agentSessionDraftsAtom).get(sessionId) ?? '',
    html: store.get(agentSessionDraftHtmlAtom).get(sessionId) ?? '',
  }
  const next = appendQuoteToAgentDraft(current, quote)
  if (!next) return false

  store.set(agentSessionDraftsAtom, (previous) => {
    if (previous.get(sessionId) === next.markdown) return previous
    const map = new Map(previous)
    map.set(sessionId, next.markdown)
    return map
  })
  store.set(agentSessionDraftHtmlAtom, (previous) => {
    if (previous.get(sessionId) === next.html) return previous
    const map = new Map(previous)
    map.set(sessionId, next.html)
    return map
  })
  store.set(agentSessionDraftSyncVersionsAtom, (previous) => {
    const map = new Map(previous)
    map.set(sessionId, (previous.get(sessionId) ?? 0) + 1)
    return map
  })

  return true
}
