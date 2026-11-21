/**
 * Chat Atoms - 侧栏问答相关的 Jotai 状态
 *
 * 管理对话列表、per-conversation 流式状态 Map、模型选择、
 * 上下文管理、思考模式与草稿等。Chat 主入口已退役，问答经 SidePanel 参数化渲染。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { atomFamily } from 'jotai-family'
import type { ConversationMeta, FileAttachment, ChatToolActivity, Channel, GeminiThinkingLevel } from '@proma/shared'
import type { QuotedSelection } from './preview-atoms'

/** 全局渠道列表缓存（启动时加载一次，设置变更时刷新） */
export const channelsAtom = atom<Channel[]>([])

/** 渠道列表是否已完成首次加载 */
export const channelsLoadedAtom = atom(false)

/** 主输入框「模型选择器」是否打开（错误卡片的「重新选择模型」按钮会置 true） */
export const modelSelectorOpenAtom = atom(false)

/** 选中的模型信息 */
export interface SelectedModel {
  channelId: string
  modelId: string
}

/** 上下文长度选项值 */
export type ContextLengthValue = 0 | 5 | 10 | 15 | 20 | 'infinite'

/** 上下文长度选项列表 */
export const CONTEXT_LENGTH_OPTIONS: ContextLengthValue[] = [0, 5, 10, 15, 20, 'infinite']

/** 对话列表 */
export const conversationsAtom = atom<ConversationMeta[]>([])

/** 当前对话 ID */
export const currentConversationIdAtom = atom<string | null>(null)

/** Agent 会话右侧 Chat 面板，key 为 Agent sessionId，value 为 Chat conversationId */
export const agentSideChatMapAtom = atom<Map<string, string>>(new Map())

/** 右侧 Chat 的单条选区引用；与 Agent 的引用状态隔离，发送后由 ChatView 消费。 */
export const conversationQuotedSelectionMapAtom = atom<Map<string, QuotedSelection>>(new Map())

/** 单个对话的流式状态 */
export interface ConversationStreamState {
  streaming: boolean
  content: string
  reasoning: string
  model?: string
  /** 记忆工具活动列表（流式期间累积） */
  toolActivities: ChatToolActivity[]
  /** 流式开始时间戳（用于思考计时持久化） */
  startedAt?: number
}

/**
 * 全局流式状态 Map — 以 conversationId 为 key
 * 流式进行中：Map 中存在该 key
 * 流式结束后：从 Map 中删除该 key
 */
export const streamingStatesAtom = atom<Map<string, ConversationStreamState>>(new Map())

/**
 * 当前正在流式输出的对话 ID 集合（派生只读原子）
 * 用于侧边栏绿色呼吸点指示器。
 *
 * 流式文本 chunk 会频繁替换 streamingStatesAtom，但通常不会改变正在运行的
 * conversation ID。复用相同 Set 引用可避免订阅该 atom 的侧边栏按 token 重渲染。
 */
let previousStreamingConversationIds = new Set<string>()
let previousStreamingConversationIdsSignature = ''

export const streamingConversationIdsAtom = atom<Set<string>>((get) => {
  const states = get(streamingStatesAtom)
  const ids: string[] = []
  for (const [id, state] of states) {
    if (state.streaming) ids.push(id)
  }
  ids.sort()
  const signature = ids.join('\u0000')
  if (signature === previousStreamingConversationIdsSignature) {
    return previousStreamingConversationIds
  }

  previousStreamingConversationIdsSignature = signature
  previousStreamingConversationIds = new Set(ids)
  return previousStreamingConversationIds
})

/** 选中的模型（持久化到 localStorage） */
export const selectedModelAtom = atomWithStorage<SelectedModel | null>(
  'proma-selected-model',
  null,
)

/** 上下文长度（持久化到 localStorage，默认不限制） */
export const contextLengthAtom = atomWithStorage<ContextLengthValue>(
  'proma-context-length',
  'infinite',
)

/** 思考模式（持久化到 localStorage） */
export const thinkingEnabledAtom = atomWithStorage<boolean>(
  'proma-thinking-enabled',
  false,
)

/** Gemini 3 Chat 思考深度（模型不支持时由 adapter 安全归一化）。 */
export const thinkingLevelAtom = atomWithStorage<GeminiThinkingLevel>(
  'proma-thinking-level',
  'medium',
)

/** 待发送的附件（含本地预览 URL） */
export interface PendingAttachment extends FileAttachment {
  /** 本地预览 URL（blob URL，用于渲染缩略图） */
  previewUrl?: string
}

/** 初次加载的消息条数 */
export const INITIAL_MESSAGE_LIMIT = 10

/**
 * 流式错误消息 Map — 以 conversationId 为 key
 * 错误发生时写入，下次发送或手动关闭时清除
 */
export const chatStreamErrorsAtom = atom<Map<string, string>>(new Map())

/**
 * 对话输入框草稿 Map — 以 conversationId 为 key
 * 用于在切换对话时保留输入框内容
 */
export const conversationDraftsAtom = atom<Map<string, string>>(new Map())

/** 明确外部草稿写入的版本号；RichTextInput 用它区分本地回写与强制覆盖。 */
export const conversationDraftSyncVersionsAtom = atom<Map<string, number>>(new Map())

/** 单个对话的外部草稿同步版本派生 atom。 */
export const conversationDraftSyncVersionAtomFamily = atomFamily((conversationId: string) =>
  atom((get) => get(conversationDraftSyncVersionsAtom).get(conversationId) ?? 0),
)

/**
 * Chat 消息刷新版本 Map — 以 conversationId 为 key
 * 全局监听器在流式完成/错误时递增版本号，
 * ChatView 监听版本号变化来重新加载消息。
 */
export const chatMessageRefreshAtom = atom<Map<string, number>>(new Map())

// ===== Agent 模式推荐 =====

/** Agent 模式推荐数据（由 suggest_agent_mode 工具结果写入） */
export interface AgentRecommendation {
  /** 推荐理由（AI 生成，描述 Agent 如何帮助用户） */
  reason: string
  /** 建议的 Agent 初始提示词 */
  suggestedPrompt: string
  /** 来源对话 ID（用于对话切换时清除） */
  conversationId: string
}

/** 待处理的 Agent 模式推荐（工具结果写入，用户操作/关闭/切换对话时清除） */
export const pendingAgentRecommendationAtom = atom<AgentRecommendation | null>(null)

// ===== Per-conversation 设置 Map =====
// 分屏时每个 ChatView 实例独立控制，缺省时使用全局默认值

/** 每个对话的模型选择 */
export const conversationModelsAtom = atom<Map<string, SelectedModel | null>>(new Map())

/** 每个对话的上下文长度 */
export const conversationContextLengthAtom = atom<Map<string, ContextLengthValue>>(new Map())

/** 每个对话的思考模式 */
export const conversationThinkingEnabledAtom = atom<Map<string, boolean>>(new Map())

/** 每个对话的 Gemini 3 思考深度。 */
export const conversationThinkingLevelAtom = atom<Map<string, GeminiThinkingLevel>>(new Map())

/** 每个对话的并排模式 */
export const conversationParallelModeAtom = atom<Map<string, boolean>>(new Map())
