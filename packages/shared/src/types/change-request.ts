/**
 * 变更请求（Pull Request）类型与 URL 工具。
 *
 * 只支持 https 的 GitHub 风格 `/<owner>/<repo>/pull/<number>` 链接；
 * 归一化后是判断「同一条 PR」的唯一依据，避免同一链接的大小写或尾斜杠造成重复绑定。
 */

export type ChangeRequestState = 'OPEN' | 'MERGED' | 'CLOSED'

export interface ChangeRequestCheck {
  name: string
  /** Check 运行状态，例如 PENDING / COMPLETED */
  status: string
  /** 结论，例如 SUCCESS / FAILURE */
  conclusion: string
}

export interface ChangeRequestSnapshot {
  title: string
  state: ChangeRequestState
  isDraft: boolean
  headRefName: string
  baseRefName: string
  reviewDecision: string
  /** MERGEABLE / CONFLICTING / UNKNOWN */
  mergeable: string
  checks: ChangeRequestCheck[]
  fetchedAt: number
}

/** 绑定的来源：自动发现、Agent 创建、正文引用或用户手动关联。 */
export type ChangeRequestBindingSource = 'tracked' | 'discovered' | 'created' | 'referenced'

export interface ChangeRequestBinding {
  url: string
  host: string
  owner: string
  repo: string
  number: number
  source: ChangeRequestBindingSource
  createdAt: number
  /** 用户从列表里隐藏；仍可恢复。 */
  dismissed?: boolean
  snapshot?: ChangeRequestSnapshot
  fetchedAt?: number
  /** 最近一次读取失败的原因；存在时 UI 显示「状态过期」。 */
  error?: string
}

export type ChangeRequestsAction = 'list' | 'discover' | 'refresh' | 'track' | 'dismiss' | 'restore' | 'remove'

export interface ChangeRequestsActionInput {
  sessionId: string
  action: ChangeRequestsAction
  /** track / dismiss / restore / remove 必填；refresh 可指定单条。 */
  url?: string
}

export interface ChangeRequestsActionResult {
  session: unknown
  error?: string
}

/** 兼容旧版本单条 pullRequest 字段。 */
export interface LegacyPullRequestBinding {
  host: string
  owner: string
  repo: string
  number: number
  url?: string
  title?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  baseRefName?: string
  reviewDecision?: string
  checks?: ChangeRequestCheck[]
  updatedAt?: number
}

export const CHANGE_REQUESTS_IPC_CHANNELS = {
  /** 执行 list / discover / refresh / track / dismiss / restore / remove */
  ACTION: 'agent:change-requests-action',
  /** 主进程推送：某些会话的变更请求状态已更新 */
  CHANGED: 'agent:change-requests-changed',
} as const

const SEGMENT = /^[A-Za-z0-9_.-]+$/
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

function isSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..'
}

export interface ChangeRequestRef {
  host: string
  owner: string
  repo: string
  number: number
}

/** 解析 PR 链接；不是受支持的 https PR 链接时返回 null。 */
export function parseChangeRequestUrl(input: string): ChangeRequestRef | null {
  const value = input.trim()
  if (!value || value.length > 2000) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port) return null
  const host = url.hostname.toLowerCase()
  if (!HOST.test(host)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 4 || parts[2] !== 'pull') return null
  const [owner, repo, , digits] = parts
  if (!owner || !repo || !digits || !isSegment(owner) || !isSegment(repo)) return null
  if (!/^[1-9]\d*$/.test(digits)) return null
  const number = Number(digits)
  if (!Number.isSafeInteger(number)) return null
  return { host, owner, repo, number }
}

export function changeRequestUrlOf(ref: ChangeRequestRef): string {
  return `https://${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}/pull/${ref.number}`
}

export function normalizeChangeRequestUrl(input: string): string | null {
  const ref = parseChangeRequestUrl(input)
  return ref ? changeRequestUrlOf(ref) : null
}

export function sameChangeRequestUrl(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** Check 是否仍在跑；用于决定轮询节奏。 */
export function isCheckPending(check: ChangeRequestCheck): boolean {
  const status = (check.status || '').toUpperCase()
  return status === 'PENDING' || status === 'QUEUED' || status === 'IN_PROGRESS' || status === 'WAITING'
}

/** 视为失败的结论；覆盖 CheckRun 与经典 StatusContext 的终态。 */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'])

/**
 * Check 是否失败。
 *
 * 新快照统一写入 conclusion；旧快照里经典 StatusContext 的 state 可能落在
 * status 字段，因此这里同时兼容两种存储形态。
 */
export function isCheckFailed(check: ChangeRequestCheck): boolean {
  const conclusion = (check.conclusion || '').toUpperCase()
  if (conclusion) return FAILED_CONCLUSIONS.has(conclusion)
  const status = (check.status || '').toUpperCase()
  return status === 'FAILURE' || status === 'ERROR'
}

/** Check 是否成功；同样兼容旧快照把 StatusContext state 写在 status 的情况。 */
export function isCheckSuccessful(check: ChangeRequestCheck): boolean {
  const conclusion = (check.conclusion || '').toUpperCase()
  if (conclusion) return conclusion === 'SUCCESS'
  return (check.status || '').toUpperCase() === 'SUCCESS'
}

export function normalizeChangeRequestState(state: string | undefined): ChangeRequestState {
  const value = (state || '').toUpperCase()
  return value === 'MERGED' || value === 'CLOSED' ? value : 'OPEN'
}

/** 从自由文本里抽取 PR 链接，按归一化结果去重。 */
export function extractChangeRequestUrls(text: string): string[] {
  if (!text || text.length > 512 * 1024) return []
  const urls: string[] = []
  for (const match of text.match(/https?:\/\/[^\s"'<>`)\]]+/gi) ?? []) {
    const normalized = normalizeChangeRequestUrl(match.replace(/[.,;:]+$/, ''))
    if (normalized && !urls.includes(normalized)) urls.push(normalized)
  }
  return urls
}
