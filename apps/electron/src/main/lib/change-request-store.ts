/**
 * 变更请求绑定的持久化。
 *
 * 绑定存在会话元数据里（`changeRequests`），一条会话可以关联多条 PR：
 * 同一分支被多次提 PR、或一次任务同时涉及多个仓库都很常见。
 * 状态快照也一并保存，应用重启后先显示上次结果，再由轮询刷新。
 */

import type {
  ChangeRequestBinding,
  ChangeRequestBindingSource,
  ChangeRequestSnapshot,
  LegacyPullRequestBinding,
} from '@proma/shared'
import { normalizeChangeRequestState, normalizeChangeRequestUrl, parseChangeRequestUrl, sameChangeRequestUrl } from '@proma/shared'
import { getAgentSessionMeta, listAgentSessions, updateAgentSessionMeta } from './agent-session-manager'

function legacyPullRequestBinding(legacy: LegacyPullRequestBinding): ChangeRequestBinding | null {
  const normalized = (
    (legacy.url ? normalizeChangeRequestUrl(legacy.url) : null)
    ?? normalizeChangeRequestUrl(`https://${legacy.host}/${legacy.owner}/${legacy.repo}/pull/${legacy.number}`)
  )
  const ref = normalized ? parseChangeRequestUrl(normalized) : null
  if (!normalized || !ref) return null
  const fetchedAt = Number.isFinite(legacy.updatedAt) ? legacy.updatedAt! : Date.now()
  return {
    url: normalized,
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    source: 'tracked',
    createdAt: fetchedAt,
    snapshot: {
      title: legacy.title ?? '',
      state: normalizeChangeRequestState(legacy.state),
      isDraft: legacy.isDraft === true,
      headRefName: legacy.headRefName ?? '',
      baseRefName: legacy.baseRefName ?? '',
      reviewDecision: legacy.reviewDecision ?? '',
      mergeable: 'UNKNOWN',
      checks: Array.isArray(legacy.checks) ? legacy.checks : [],
      fetchedAt,
    },
    fetchedAt,
  }
}

function bindingsOf(session: { changeRequests?: ChangeRequestBinding[] } | undefined): ChangeRequestBinding[] {
  return Array.isArray(session?.changeRequests) ? session.changeRequests : []
}

function dedupeBindings(bindings: ChangeRequestBinding[]): ChangeRequestBinding[] {
  const result: ChangeRequestBinding[] = []
  for (const binding of bindings) {
    if (result.some((item) => sameChangeRequestUrl(item.url, binding.url))) continue
    result.push(binding)
  }
  return result
}

function createBinding(
  url: string,
  source: ChangeRequestBindingSource,
  createdAt: number,
): ChangeRequestBinding | null {
  const normalized = normalizeChangeRequestUrl(url)
  const ref = normalized ? parseChangeRequestUrl(normalized) : null
  if (!normalized || !ref) return null
  return {
    url: normalized,
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    source,
    createdAt,
  }
}

function mergeBindingLists(
  existing: ChangeRequestBinding[],
  incomingUrls: string[],
  source: ChangeRequestBindingSource,
  createdAt: number,
  accept?: (url: string) => boolean,
): ChangeRequestBinding[] {
  const result = [...existing]
  let changed = false
  for (const url of incomingUrls) {
    const binding = createBinding(url, source, createdAt)
    if (!binding) continue
    if (accept !== undefined && !accept(binding.url)) continue
    if (result.some((item) => sameChangeRequestUrl(item.url, binding.url))) continue
    result.push(binding)
    changed = true
  }
  return changed ? result : existing
}

function setBindingDismissed(
  existing: ChangeRequestBinding[],
  url: string,
  dismissed: boolean,
): ChangeRequestBinding[] {
  const target = existing.find((binding) => (
    sameChangeRequestUrl(binding.url, url) && Boolean(binding.dismissed) !== dismissed
  ))
  if (!target) return existing
  return existing.map((binding) => (binding === target ? { ...binding, dismissed } : binding))
}

function writeBindings(sessionId: string, bindings: ChangeRequestBinding[]): ChangeRequestBinding[] {
  const next = dedupeBindings(bindings)
  updateAgentSessionMeta(sessionId, { changeRequests: next })
  return next
}

function sameChecks(left: ChangeRequestSnapshot['checks'], right: ChangeRequestSnapshot['checks']): boolean {
  if (left.length !== right.length) return false
  return left.every((check, index) => {
    const other = right[index]
    return !!other && check.name === other.name && check.status === other.status && check.conclusion === other.conclusion
  })
}

function sameSnapshot(left?: ChangeRequestSnapshot, right?: ChangeRequestSnapshot): boolean {
  if (!left || !right) return left === right
  return left.title === right.title
    && left.state === right.state
    && left.isDraft === right.isDraft
    && left.headRefName === right.headRefName
    && left.baseRefName === right.baseRefName
    && left.reviewDecision === right.reviewDecision
    && left.mergeable === right.mergeable
    && sameChecks(left.checks, right.checks)
}

/** 读取会话绑定，顺带把旧版单条 pullRequest 迁移过来。 */
export function listBindings(sessionId: string): ChangeRequestBinding[] {
  const session = getAgentSessionMeta(sessionId)
  if (!session) return []
  if (!session.pullRequest) return dedupeBindings(bindingsOf(session))
  const legacy = legacyPullRequestBinding(session.pullRequest)
  if (!legacy) {
    console.warn(`[变更请求] 旧 pullRequest 无法迁移，保留原值: ${sessionId}`)
    return dedupeBindings(bindingsOf(session))
  }
  const merged = dedupeBindings([...bindingsOf(session), legacy])
  updateAgentSessionMeta(sessionId, { changeRequests: merged, pullRequest: undefined })
  return merged
}

/** 应用启动时批量迁移历史会话的 pullRequest 字段。 */
export function migrateLegacyBindings(): string[] {
  const migrated: string[] = []
  for (const session of listAgentSessions()) {
    if (!session.pullRequest) continue
    const legacy = legacyPullRequestBinding(session.pullRequest)
    if (!legacy) {
      console.warn(`[变更请求] 旧 pullRequest 无法迁移，保留原值: ${session.id}`)
      continue
    }
    const merged = dedupeBindings([...bindingsOf(session), legacy])
    updateAgentSessionMeta(session.id, { changeRequests: merged, pullRequest: undefined })
    migrated.push(session.id)
  }
  return migrated
}

export function trackBinding(
  sessionId: string,
  url: string,
  source: ChangeRequestBindingSource = 'tracked',
): ChangeRequestBinding[] {
  const binding = createBinding(url, source, Date.now())
  if (!binding) throw new Error('请输入当前 GitHub host 的变更请求链接。')
  const bindings = listBindings(sessionId)
  const existing = bindings.find((item) => sameChangeRequestUrl(item.url, binding.url))
  if (existing) {
    if (!existing.dismissed) return bindings
    return writeBindings(sessionId, setBindingDismissed(bindings, binding.url, false))
  }
  return writeBindings(sessionId, [...bindings, binding])
}

export function dismissBinding(sessionId: string, url: string): ChangeRequestBinding[] {
  const bindings = listBindings(sessionId)
  const next = setBindingDismissed(bindings, url, true)
  if (next === bindings) return bindings
  return writeBindings(sessionId, next)
}

export function restoreBinding(sessionId: string, url: string): ChangeRequestBinding[] {
  const bindings = listBindings(sessionId)
  const next = setBindingDismissed(bindings, url, false)
  if (next === bindings) return bindings
  return writeBindings(sessionId, next)
}

export function removeBinding(sessionId: string, url: string): ChangeRequestBinding[] {
  const bindings = listBindings(sessionId)
  const remaining = bindings.filter((binding) => !sameChangeRequestUrl(binding.url, url))
  if (remaining.length === bindings.length) return bindings
  return writeBindings(sessionId, remaining)
}

/** 合并自动发现的绑定；`accept` 用于把范围限制在当前仓库。 */
export function mergeBindings(
  sessionId: string,
  urls: string[],
  source: ChangeRequestBindingSource,
  accept?: (url: string) => boolean,
): ChangeRequestBinding[] {
  const bindings = listBindings(sessionId)
  const merged = mergeBindingLists(bindings, urls, source, Date.now(), accept)
  if (merged === bindings) return bindings
  return writeBindings(sessionId, merged)
}

export type ChangeRequestFetchResult =
  | { snapshot: ChangeRequestSnapshot }
  | { error: string }

/** 写入一次轮询结果；内容未变时不动磁盘，避免无意义的会话索引写入。 */
export function applyBindingResult(
  sessionId: string,
  url: string,
  result: ChangeRequestFetchResult,
): ChangeRequestBinding[] {
  const bindings = listBindings(sessionId)
  const existing = bindings.find((binding) => sameChangeRequestUrl(binding.url, url))
  if (!existing) return bindings

  const fetchedAt = Date.now()
  let updated: ChangeRequestBinding
  if ('snapshot' in result) {
    if (!existing.error && sameSnapshot(existing.snapshot, result.snapshot)) return bindings
    updated = { ...existing, snapshot: result.snapshot, fetchedAt, error: undefined }
  } else {
    if (existing.error === result.error) return bindings
    updated = { ...existing, error: result.error, fetchedAt }
  }
  return writeBindings(sessionId, bindings.map((binding) => (binding === existing ? updated : binding)))
}

/** 哪些会话绑定了这条 PR；轮询一次即可更新所有引用方。 */
export function ownersOfUrl(url: string, sessions = listAgentSessions()): string[] {
  const owners: string[] = []
  for (const session of sessions) {
    if (dedupeBindings(bindingsOf(session)).some((binding) => sameChangeRequestUrl(binding.url, url))) {
      owners.push(session.id)
    }
  }
  return owners
}

/** 轮询器需要的成员关系：会话 → 未隐藏的 PR 链接。 */
export function listBoundSessions(sessions = listAgentSessions()): Array<{ sessionId: string; urls: string[] }> {
  const result: Array<{ sessionId: string; urls: string[] }> = []
  for (const session of sessions) {
    const urls = dedupeBindings(bindingsOf(session))
      .filter((binding) => !binding.dismissed)
      .map((binding) => normalizeChangeRequestUrl(binding.url))
      .filter((url): url is string => Boolean(url))
    if (urls.length > 0) result.push({ sessionId: session.id, urls })
  }
  return result
}
