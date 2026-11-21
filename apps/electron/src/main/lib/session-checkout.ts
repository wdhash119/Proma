/**
 * 会话检出解析（纯逻辑）。
 *
 * 会话的 cwd 不是单一值：用户可能在私有工作台、项目根和多个 worktree 之间切换。
 * 这里维护一份按时间追加的检出日志，解析时从最新一项向前找仍然存在的目录，
 * 于是某个 worktree 被删掉时只回退一级，而不是把整个会话判定为不可用。
 */

import type { SessionCheckoutEntry, SessionCheckoutKind } from '@proma/shared'

/** 检出日志最多保留的条数；超出后丢弃最旧的记录。 */
export const MAX_CHECKOUT_HISTORY = 20

export interface CheckoutActiveWorktree {
  path: string
  mainRepoRoot: string
  branch: string
  selectedAt: number
}

export interface ResolveSessionCheckoutInput {
  history?: SessionCheckoutEntry[]
  activeWorktree?: CheckoutActiveWorktree
  /** 缺失时按 session 工作台处理，兼容历史数据。 */
  agentCwdMode?: 'project' | 'session'
  /** 项目根目录（Proma 托管项目时为项目文件目录） */
  projectPath?: string
  /** 会话私有工作台目录 */
  workbenchPath?: string
  isDirectory: (path: string) => boolean
}

export interface ResolvedSessionCheckout extends SessionCheckoutEntry {
  /** 最新记录已不存在、使用了更早的目录或默认检出。 */
  fellBack: boolean
}

export function checkoutFromActiveWorktree(
  activeWorktree: CheckoutActiveWorktree,
  baseCommit?: string,
): SessionCheckoutEntry {
  return {
    kind: 'worktree',
    path: activeWorktree.path,
    mainRepoRoot: activeWorktree.mainRepoRoot,
    branch: activeWorktree.branch,
    ...(baseCommit ? { baseCommit } : {}),
    since: activeWorktree.selectedAt,
  }
}

export function defaultCheckout(
  agentCwdMode: 'project' | 'session' | undefined,
  projectPath: string | undefined,
  workbenchPath: string | undefined,
): SessionCheckoutEntry | null {
  if (agentCwdMode === 'project') {
    return projectPath ? { kind: 'project', path: projectPath, since: 0 } : null
  }
  return workbenchPath ? { kind: 'workbench', path: workbenchPath, since: 0 } : null
}

/** 解析会话当前应使用的 cwd；所有候选目录都不存在时返回 null。 */
export function resolveSessionCheckout(input: ResolveSessionCheckoutInput): ResolvedSessionCheckout | null {
  const history = input.history ?? []
  const lastIndex = history.length - 1

  for (let index = lastIndex; index >= 0; index -= 1) {
    const entry = history[index]
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue
    if (!input.isDirectory(entry.path)) continue
    return { ...entry, fellBack: index !== lastIndex }
  }

  // 旧数据没有日志时仍以 activeWorktree 为准。
  if (history.length === 0 && input.activeWorktree?.path && input.isDirectory(input.activeWorktree.path)) {
    return { ...checkoutFromActiveWorktree(input.activeWorktree), fellBack: false }
  }

  const fallback = defaultCheckout(input.agentCwdMode, input.projectPath, input.workbenchPath)
  if (!fallback) return null
  return { ...fallback, fellBack: history.length > 0 || Boolean(input.activeWorktree?.path) }
}

/** 追加一条检出记录：同路径去重后放到末尾，并裁到上限。 */
export function appendCheckoutEntry(
  history: SessionCheckoutEntry[] | undefined,
  entry: SessionCheckoutEntry,
): SessionCheckoutEntry[] {
  const kept = (history ?? []).filter((item) => item.path !== entry.path)
  kept.push(entry)
  return kept.slice(-MAX_CHECKOUT_HISTORY)
}

/** 最新一条记录是否就是该路径。 */
export function isCurrentCheckout(history: SessionCheckoutEntry[] | undefined, path: string): boolean {
  const last = history?.[(history?.length ?? 0) - 1]
  return last?.path === path
}

/**
 * 列出可恢复的 worktree：日志里仍是 worktree 类型、但目录已经不存在。
 * 按最近使用排序，供「恢复已删除的 worktree」入口展示。
 */
export function listRestorableWorktrees(
  history: SessionCheckoutEntry[] | undefined,
  isDirectory: (path: string) => boolean,
): SessionCheckoutEntry[] {
  return (history ?? [])
    .filter((entry) => entry.kind === 'worktree' && !!entry.branch && !!entry.mainRepoRoot)
    .filter((entry) => !isDirectory(entry.path))
    .sort((left, right) => right.since - left.since)
}

/** 判断路径是否为 worktree 检出（用于 UI 徽标）。 */
export function isWorktreeCheckoutKind(kind: SessionCheckoutKind): boolean {
  return kind === 'worktree'
}
