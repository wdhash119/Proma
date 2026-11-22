import type { AgentSessionMeta, AgentStreamCompletePayload, AutomationResultNotifyPolicy } from '@proma/shared'
import { shouldNotifyByPolicy } from '@proma/shared'
import type { TabItem } from '@/atoms/tab-atoms'
import { isDelegationObservationVisible } from '@/lib/agent-session-list'

interface AgentCompletionPresenceInput {
  tabs: TabItem[]
  activeTabId: string | null
  currentAgentSessionId: string | null
  sessionId: string
  /** 委派子会话由父会话汇总，不计入用户级未读完成。 */
  session?: Pick<AgentSessionMeta, 'sourceDelegationId'>
  /** 完成发生时应用窗口是否处于前台。窗口失焦时即使是当前 Tab 也不算"正在查看"。 */
  documentHasFocus: boolean
}

interface AgentCompletionMarkers {
  markUnviewedCompleted: boolean
}

interface AgentCompletionNotificationInput {
  completion: AgentStreamCompletePayload
  session?: Pick<AgentSessionMeta, 'sourceDelegationId' | 'parentSessionId' | 'sourceAutomationId'>
}

export interface CompletionNotificationDecisionInput extends AgentCompletionNotificationInput {
  hasStreamError: boolean
  /** 本轮仍有后台任务在飞行：完成提醒要等真正结束。 */
  backgroundTasksPending: boolean
  /** 完成时用户是否确实没有查看该会话（doc 焦点 + 激活 Tab 的综合结论）。 */
  unviewed: boolean
  notificationsEnabled: boolean
  soundEnabled: boolean
  /** 来源定时任务的结果提醒策略；非定时任务不传，按 always 处理。 */
  notifyPolicy?: AutomationResultNotifyPolicy
}

interface CompletionNotificationDecision {
  /** 是否发送桌面通知（系统通知自身仍按窗口焦点决定是否弹出）。 */
  notify: boolean
  /** 是否播放完成提示音；与桌面通知共用同一次发送，避免双响。 */
  sound: boolean
}

/** 仅顶层 Agent 会话完成属于用户级任务完成提醒边界 */
function shouldNotifyAgentCompletion({
  completion,
  session,
}: AgentCompletionNotificationInput): boolean {
  return completion.triggeredBy !== 'delegation' && !session?.sourceDelegationId
}

export function markSessionCompletionUnviewed(
  sessionIds: Set<string>,
  sessionId: string,
): Set<string> {
  if (sessionIds.has(sessionId)) return sessionIds
  const next = new Set(sessionIds)
  next.add(sessionId)
  return next
}

export function markSessionCompletionViewed(
  sessionIds: Set<string>,
  sessionId: string,
): Set<string> {
  if (!sessionIds.has(sessionId)) return sessionIds
  const next = new Set(sessionIds)
  next.delete(sessionId)
  return next
}

function isSuccessfulAgentCompletion(
  completion: AgentStreamCompletePayload,
  hasStreamError: boolean,
): boolean {
  return !completion.stoppedByUser &&
    !hasStreamError &&
    (!completion.resultSubtype || completion.resultSubtype === 'success')
}

type DelegatedCompletionAttention = 'viewed' | 'unviewed' | null

interface DelegatedCompletionAttentionInput extends AgentCompletionNotificationInput {
  hasStreamError: boolean
  activeSessionId: string | null
  selectedDelegationSessionId: string | null
  activeSidePanelTab: string | undefined
  split: { leftTab: string; rightTab: string } | null
  sidePanelOpen: boolean
  windowHasFocus: boolean
}

/** Resolve delegated completion to one attention transition; null means no state change. */
export function getDelegatedCompletionAttention({
  completion,
  session,
  hasStreamError,
  activeSessionId,
  selectedDelegationSessionId,
  activeSidePanelTab,
  split,
  sidePanelOpen,
  windowHasFocus,
}: DelegatedCompletionAttentionInput): DelegatedCompletionAttention {
  if (completion.triggeredBy !== 'delegation' && !session?.sourceDelegationId) return null

  const visible = !!session?.parentSessionId
    && windowHasFocus
    && activeSessionId === session.parentSessionId
    && selectedDelegationSessionId === completion.sessionId
    && isDelegationObservationVisible(sidePanelOpen, activeSidePanelTab, split)
  if (visible) return 'viewed'

  return !completion.backgroundTasksPending && isSuccessfulAgentCompletion(completion, hasStreamError)
    ? 'unviewed'
    : null
}

/**
 * 单一完成提醒入口。
 *
 * 失败、用户停止、委派子会话、已查看的完成与仍有后台任务的轮次都保持安静；
 * 定时任务额外受 notifyPolicy 约束。返回的 notify/sound 由调用方在同一次
 * 桌面通知发送中使用，保证成功未查看时只响一次。
 */
export function decideCompletionNotification(
  input: CompletionNotificationDecisionInput,
): CompletionNotificationDecision {
  const silent: CompletionNotificationDecision = { notify: false, sound: false }
  if (input.backgroundTasksPending) return silent
  if (!input.unviewed) return silent
  if (!isSuccessfulAgentCompletion(input.completion, input.hasStreamError)) return silent
  if (!shouldNotifyAgentCompletion({ completion: input.completion, session: input.session })) return silent
  // 定时任务额外受结果提醒策略约束；走到这里只可能是成功结果。
  if (input.session?.sourceAutomationId && !shouldNotifyByPolicy(input.notifyPolicy, 'success')) return silent
  return {
    notify: input.notificationsEnabled,
    sound: input.notificationsEnabled && input.soundEnabled,
  }
}

/** 判断 Agent 完成时用户是否仍停留在该会话入口 */
function isAgentSessionActiveForCompletion({
  tabs,
  activeTabId,
  currentAgentSessionId,
  sessionId,
  documentHasFocus,
}: AgentCompletionPresenceInput): boolean {
  // 窗口不在前台时用户不可能正在查看，一律按"未查看"处理，
  // 与角标清除端（依赖 document.hasFocus()）的语义保持对齐。
  if (!documentHasFocus) return false

  const activeTab = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : null
  if (activeTab) {
    return (activeTab.type === 'agent' || activeTab.type === 'preview') && activeTab.sessionId === sessionId
  }

  return currentAgentSessionId === sessionId
}

/** 计算 Agent 完成后是否需要写入侧边栏完成提醒 */
export function getAgentCompletionMarkers(input: AgentCompletionPresenceInput): AgentCompletionMarkers {
  const isActiveSession = isAgentSessionActiveForCompletion(input)
  return {
    markUnviewedCompleted: !input.session?.sourceDelegationId && !isActiveSession,
  }
}
