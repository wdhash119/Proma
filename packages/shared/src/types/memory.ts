/**
 * 记忆维护 IPC 通道：全局画像与项目记忆的读取、检索、历史与恢复。
 * 写入由 Agent 的 MemoryUpdate 工具完成，渲染进程只负责展示与恢复。
 */

export interface MemoryTargetSummary {
  target: string
  kind: 'global-profile' | 'project-index' | 'project-theme'
  label: string
  chars: number
  revision: string
  updatedAt?: number
  budgetChars?: number
}

export interface MemoryDocumentPayload {
  target: string
  kind: MemoryTargetSummary['kind']
  content: string
  revision: string
  chars: number
  path: string
  budgetChars?: number
}

export interface MemoryRevisionItem {
  id: string
  target: string
  createdAt: number
  summary: string
  chars: number
}

export interface MemorySearchResultItem {
  source: string
  target: string
  line: number
  text: string
  score: number
}

/** 恢复历史版本的请求；expectedCurrentRevision 用于拒绝并发覆盖。 */
export interface MemoryRestoreRevisionInput {
  target: string
  id: string
  /** 调用方读取正文时拿到的 revision；与恢复前当前正文不一致即拒绝。 */
  expectedCurrentRevision: string
  workspaceSlug?: string
}

export interface MemoryRestoreRevisionResult {
  target: string
  revision: string
  chars: number
  snapshotId?: string
}

export const MEMORY_IPC_CHANNELS = {
  /** 列出全局画像与当前工作区的记忆目标 */
  LIST_TARGETS: 'memory:list-targets',
  /** 读取单个记忆目标正文 */
  READ_TARGET: 'memory:read-target',
  /** 跨全局画像与项目记忆检索 */
  SEARCH: 'memory:search',
  /** 列出某个目标的历史版本 */
  LIST_HISTORY: 'memory:list-history',
  /** 读取某个历史版本正文 */
  READ_REVISION: 'memory:read-revision',
  /** 恢复到某个历史版本 */
  RESTORE_REVISION: 'memory:restore-revision',
} as const
