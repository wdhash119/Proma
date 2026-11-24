import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import {
  agentSessionDraftHtmlAtom,
  agentSessionDraftSyncVersionsAtom,
  agentSessionDraftsAtom,
} from '@/atoms/agent-atoms'
import { appendQuoteToAgentDraft, appendQuoteToSessionDraft } from './agent-draft-quote'
import { serializeQuotedSelectionMention } from './quoted-selection'

function fileQuote(overrides: Partial<QuotedSelection> = {}): QuotedSelection {
  return {
    text: '第一段选中文字',
    filePath: '/repo/docs/guide.md',
    sourceType: 'file',
    sourceLabel: 'guide.md',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function chipCount(html: string): number {
  return html.split('data-mention-quote=').length - 1
}

describe('向 Agent 草稿追加选区引用 chip', () => {
  test('Given 空草稿 When 追加首个引用 Then markdown 与 HTML 各写入一个 chip', () => {
    const quote = fileQuote()
    const next = appendQuoteToAgentDraft({ markdown: '', html: '' }, quote)

    expect(next).not.toBeNull()
    const marker = serializeQuotedSelectionMention(quote) ?? ''
    expect(marker).not.toBe('')
    expect(next?.markdown).toBe(marker)
    expect(chipCount(next?.html ?? '')).toBe(1)
    expect(next?.html).toContain('data-type="mention"')
    expect(next?.html).toContain('data-mention-suggestion-char="&"')
    expect(next?.html).toContain(`data-id="${quote.filePath}:${quote.capturedAt}"`)
    expect(next?.html).toContain('data-label="guide.md：第一段选中文字"')
  })

  test('Given 已有纯文本与一个 chip When 追加第二个引用 Then 原有文字与两个 chip 全部保留', () => {
    const first = fileQuote()
    const second = fileQuote({ text: '第二段选中文字', sourceLabel: 'other.md', filePath: '/repo/docs/other.md', capturedAt: 1_700_000_000_001 })

    const afterFirst = appendQuoteToAgentDraft({ markdown: '请对比这两段：', html: '<p>请对比这两段：</p>' }, first)
    expect(afterFirst).not.toBeNull()

    const afterSecond = appendQuoteToAgentDraft(afterFirst ?? { markdown: '', html: '' }, second)
    expect(afterSecond).not.toBeNull()

    const firstMarker = serializeQuotedSelectionMention(first) ?? ''
    const secondMarker = serializeQuotedSelectionMention(second) ?? ''

    expect(afterSecond?.markdown.startsWith('请对比这两段：')).toBe(true)
    expect(afterSecond?.markdown).toContain(firstMarker)
    expect(afterSecond?.markdown).toContain(secondMarker)
    expect(afterSecond?.markdown.indexOf(firstMarker)).toBeLessThan(afterSecond?.markdown.indexOf(secondMarker) ?? -1)

    expect(afterSecond?.html.startsWith('<p>请对比这两段：</p>')).toBe(true)
    expect(chipCount(afterSecond?.html ?? '')).toBe(2)
    expect(afterSecond?.html).toContain(`data-id="${first.filePath}:${first.capturedAt}"`)
    expect(afterSecond?.html).toContain(`data-id="${second.filePath}:${second.capturedAt}"`)
  })

  test('Given 只有 markdown 草稿 When 追加引用 Then HTML 由 markdown 转换后追加 chip', () => {
    const next = appendQuoteToAgentDraft({ markdown: '保留这段文字', html: '' }, fileQuote())

    expect(next).not.toBeNull()
    expect(next?.html).toContain('保留这段文字')
    expect(chipCount(next?.html ?? '')).toBe(1)
    expect(next?.markdown).toContain('保留这段文字')
  })

  test('Given 两个会话各自的草稿 When 分别追加引用 Then 互不影响且各自递增同步版本', () => {
    const store = createStore()
    const sessionA = 'selection-a'
    const sessionB = 'selection-b'

    store.set(agentSessionDraftsAtom, new Map([[sessionB, 'B 的草稿']]))
    store.set(agentSessionDraftHtmlAtom, new Map([[sessionB, '<p>B 的草稿</p>']]))

    expect(appendQuoteToSessionDraft(store, sessionA, fileQuote())).toBe(true)

    expect(store.get(agentSessionDraftsAtom).get(sessionB)).toBe('B 的草稿')
    expect(store.get(agentSessionDraftHtmlAtom).get(sessionB)).toBe('<p>B 的草稿</p>')
    expect(store.get(agentSessionDraftSyncVersionsAtom).get(sessionB)).toBeUndefined()
    expect(store.get(agentSessionDraftSyncVersionsAtom).get(sessionA)).toBe(1)

    const beforeB = store.get(agentSessionDraftsAtom).get(sessionB)
    expect(appendQuoteToSessionDraft(store, sessionB, fileQuote())).toBe(true)
    expect(store.get(agentSessionDraftsAtom).get(sessionB)).not.toBe(beforeB)
    expect(chipCount(store.get(agentSessionDraftHtmlAtom).get(sessionB) ?? '')).toBe(1)
    expect(store.get(agentSessionDraftSyncVersionsAtom).get(sessionA)).toBe(1)
    expect(store.get(agentSessionDraftSyncVersionsAtom).get(sessionB)).toBe(1)
  })

  test('Given 非法引用 When 追加 Then 草稿保持原样且不递增同步版本', () => {
    const store = createStore()
    const sessionId = 'selection-invalid'
    store.set(agentSessionDraftsAtom, new Map([[sessionId, '已有文字']]))
    store.set(agentSessionDraftHtmlAtom, new Map([[sessionId, '<p>已有文字</p>']]))

    const invalid = fileQuote({ text: '', filePath: '' })
    expect(appendQuoteToAgentDraft({ markdown: '已有文字', html: '<p>已有文字</p>' }, invalid)).toBeNull()
    expect(appendQuoteToSessionDraft(store, sessionId, invalid)).toBe(false)

    expect(store.get(agentSessionDraftsAtom).get(sessionId)).toBe('已有文字')
    expect(store.get(agentSessionDraftHtmlAtom).get(sessionId)).toBe('<p>已有文字</p>')
    expect(store.get(agentSessionDraftSyncVersionsAtom).get(sessionId)).toBeUndefined()
  })

  test('Given HTML 中的特殊字符 When 追加引用 Then 属性被正确转义', () => {
    const quote = fileQuote({ text: '含 <tag> & "引号" 的片段', sourceLabel: 'a&b.md' })
    const next = appendQuoteToAgentDraft({ markdown: '', html: '' }, quote)

    expect(next).not.toBeNull()
    expect(next?.html).not.toContain('data-label="a&b.md')
    expect(next?.html).toContain('a&amp;b.md')
    expect(next?.html).toContain('&quot;')
    expect(chipCount(next?.html ?? '')).toBe(1)
  })
})
