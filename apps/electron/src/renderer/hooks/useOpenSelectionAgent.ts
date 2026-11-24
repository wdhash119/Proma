import * as React from 'react'
import { useStore } from 'jotai'
import type { AgentSessionMeta } from '@proma/shared'
import {
  agentChannelIdAtom,
  agentDiffPanelTabAtom,
  agentModelIdAtom,
  agentSessionsAtom,
  agentSidePanelOpenAtomFamily,
  agentSideSelectionSessionMapAtom,
  currentAgentWorkspaceIdAtom,
  getSelectionAgentSidePanelTab,
} from '@/atoms/agent-atoms'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import { appendQuoteToSessionDraft } from '@/lib/agent-draft-quote'
import { insertAgentInputQuote } from '@/lib/agent-input-quote'
import { getOrCreateSelectionAgent } from '@/lib/selection-agent-session'
import { useFocusAgentSessionInput } from './useFocusAgentSessionInput'

export interface OpenSelectionAgentInput {
  quote: QuotedSelection
  title: string
}

/** 打开或复用当前主 Agent 的选区 Agent，并把引用定向到其输入框。 */
export function useOpenSelectionAgent(parentSessionId: string): (input: OpenSelectionAgentInput) => Promise<AgentSessionMeta | null> {
  const store = useStore()
  const focusAgentSessionInput = useFocusAgentSessionInput()

  return React.useCallback(async ({ quote, title }: OpenSelectionAgentInput): Promise<AgentSessionMeta | null> => {
    const sessions = store.get(agentSessionsAtom)
    const activate = (selectionSessionId: string): void => {
      const tab = getSelectionAgentSidePanelTab(selectionSessionId)
      store.set(agentSidePanelOpenAtomFamily(parentSessionId), true)
      store.set(agentDiffPanelTabAtom, (previous) => new Map(previous).set(parentSessionId, tab))
      // 等右侧嵌入 AgentView 挂载后再聚焦；事件自身携带 sessionId，避免抢到主输入框。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        focusAgentSessionInput(selectionSessionId)
      }))
    }
    // 目标输入框尚未挂载时不能写单条引用快照：那会覆盖此前已追加的引用。
    // 改为直接追加到该会话的草稿（markdown + HTML + 同步版本），挂载后按原契约恢复。
    const appendQuoteToDraft = (selectionSessionId: string): void => {
      appendQuoteToSessionDraft(store, selectionSessionId, quote)
    }

    const existing = store.get(agentSideSelectionSessionMapAtom).get(parentSessionId)
    const existingMeta = existing
      ? sessions.find((session) => session.id === existing.sessionId)
      : undefined
    if (existing && existingMeta) {
      if (!insertAgentInputQuote(existing.sessionId, quote)) appendQuoteToDraft(existing.sessionId)
      activate(existing.sessionId)
      return existingMeta
    }

    const parent = sessions.find((session) => session.id === parentSessionId)
    const channelId = parent?.channelId ?? store.get(agentChannelIdAtom) ?? undefined
    const modelId = parent?.modelId ?? store.get(agentModelIdAtom) ?? undefined
    const workspaceId = parent?.workspaceId ?? store.get(currentAgentWorkspaceIdAtom) ?? undefined

    try {
      const created = await getOrCreateSelectionAgent(parentSessionId, () => window.electronAPI.createAgentSession(
        title,
        channelId,
        workspaceId,
        modelId,
        false,
      ))
      store.set(agentSessionsAtom, (previous) => (
        previous.some((session) => session.id === created.id) ? previous : [created, ...previous]
      ))
      store.set(agentSideSelectionSessionMapAtom, (previous) => new Map(previous).set(parentSessionId, {
        sessionId: created.id,
        sourceLabel: quote.sourceLabel ?? quote.filePath,
      }))
      // 新 AgentView 尚未挂载：直接把引用追加进该会话草稿，保证连续多次选区不会互相覆盖。
      appendQuoteToDraft(created.id)
      activate(created.id)
      return created
    } catch (error) {
      console.error('[SelectionAgent] 创建选区 Agent 失败:', error)
      return null
    }
  }, [focusAgentSessionInput, parentSessionId, store])
}
