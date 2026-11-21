/**
 * 从会话检出日志恢复被删除的 worktree。
 *
 * 只重建日志里记录过的路径与分支：先确认目标登记状态（不做仓库级 prune），
 * 再判断分支是否还在；分支已被删除时用选择当时的 HEAD 提交重建分支，
 * 避免把无关提交带进来。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { normalizePathForCompare, type RestoreSessionWorktreeResult } from '@proma/shared'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 1024 * 1024

export interface RestorableWorktreeRecord {
  path: string
  branch: string
  baseCommit?: string
}

export interface WorktreeRestoreRequest extends RestorableWorktreeRecord {
  /** worktree 所属主仓库根目录 */
  repoPath: string
}

export type WorktreeRestorePlan =
  | { ok: true; branchRecreated: boolean }
  | { ok: false; reason: 'invalid-record' | 'branch-unavailable' }

/**
 * 记录合法性：路径必须绝对、分支名必须是安全的 ref 片段。
 * 这些约束保证恢复命令不会因为脏数据变成任意路径或任意 ref 操作。
 */
export function isRestorableWorktreeRecord(input: Partial<RestorableWorktreeRecord>): boolean {
  if (typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0')) return false
  if (typeof input.branch !== 'string' || input.branch.length === 0 || input.branch.length > 255) return false
  if (input.branch.includes('\0') || input.branch.includes('..') || input.branch.startsWith('-')) return false
  if (input.branch.startsWith('/') || input.branch.endsWith('/') || input.branch.includes('//')) return false
  if (/[\s~^:?*[\\]/.test(input.branch)) return false
  if (input.baseCommit !== undefined && !/^[0-9a-f]{7,64}$/i.test(input.baseCommit)) return false
  return true
}

/** 分支还在就直接挂接，分支已删除则要求有基准提交才能重建。 */
export function planWorktreeRestore(input: RestorableWorktreeRecord & { branchExists: boolean }): WorktreeRestorePlan {
  if (!isRestorableWorktreeRecord(input)) return { ok: false, reason: 'invalid-record' }
  if (input.branchExists) return { ok: true, branchRecreated: false }
  if (input.baseCommit) return { ok: true, branchRecreated: true }
  return { ok: false, reason: 'branch-unavailable' }
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      ...(signal ? { signal } : {}),
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读取 worktree 当前 HEAD；失败返回 undefined，不阻塞选择流程。 */
export async function readWorktreeHeadCommit(worktreePath: string): Promise<string | undefined> {
  if (typeof worktreePath !== 'string' || !isAbsolute(worktreePath)) return undefined
  const result = await git(['rev-parse', 'HEAD'], worktreePath)
  if (!result.ok) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined
}

interface RegisteredWorktree {
  path: string
  branch?: string
}

/** 比较 worktree 路径；非 Linux 平台忽略大小写，避免 Windows 路径拼写差异。 */
function worktreePathKey(path: string): string {
  const normalized = normalizePathForCompare(resolve(path))
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}

/** 读取仓库当前登记的 worktree 列表（包括目录已暂时缺失的登记）。 */
async function listRegisteredWorktrees(repoPath: string, signal?: AbortSignal): Promise<RegisteredWorktree[]> {
  const result = await git(['worktree', 'list', '--porcelain'], repoPath, signal)
  if (!result.ok) throw new Error(`读取 worktree 登记失败：${result.stderr}`)
  const entries: RegisteredWorktree[] = []
  let current: RegisteredWorktree | undefined
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() }
      entries.push(current)
      continue
    }
    if (line === '') {
      current = undefined
      continue
    }
    if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
  }
  return entries
}

export async function restoreWorktree(
  request: WorktreeRestoreRequest,
  options: { signal?: AbortSignal } = {},
): Promise<RestoreSessionWorktreeResult> {
  const { path, branch, baseCommit, repoPath } = request

  if (typeof repoPath !== 'string' || !isAbsolute(repoPath)) {
    throw new Error('无法确定 worktree 所属仓库，不能恢复')
  }
  if (!isRestorableWorktreeRecord({ path, branch, baseCommit })) {
    throw new Error('worktree 记录无效，不能恢复')
  }
  if (existsSync(path)) {
    throw new Error('worktree 目录已存在，无需恢复')
  }
  if (!existsSync(repoPath)) {
    throw new Error('worktree 所属仓库目录已不存在')
  }

  // 目录被手动删除后，git 里可能仍登记着这个 worktree。
  // 这里只处理目标自己的登记：不使用仓库级 `git worktree prune`，
  // 否则会顺带注销该仓库下其他「目录暂时缺失但可恢复」的 worktree。
  const registrations = await listRegisteredWorktrees(repoPath, options.signal)
  const registration = registrations.find((item) => worktreePathKey(item.path) === worktreePathKey(path))
  if (registration?.branch && registration.branch !== branch) {
    throw new Error('该路径仍登记为其他分支的 worktree，不能按当前记录恢复')
  }

  const branchCheck = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, options.signal)
  const plan = planWorktreeRestore({ path, branch, baseCommit, branchExists: branchCheck.ok })
  if (!plan.ok) {
    throw new Error(plan.reason === 'branch-unavailable'
      ? `分支 ${branch} 已删除且缺少基准提交，无法恢复`
      : 'worktree 记录无效，不能恢复')
  }

  // 目标仍登记时用 `-f` 覆盖这条失效登记；其他 worktree 的登记保持不变。
  const forceArgs = registration ? ['-f'] : []
  const add = plan.branchRecreated
    ? await git(['worktree', 'add', ...forceArgs, '-b', branch, path, baseCommit!], repoPath, options.signal)
    : await git(['worktree', 'add', ...forceArgs, path, branch], repoPath, options.signal)
  if (!add.ok) throw new Error(`恢复 worktree 失败：${add.stderr}`)

  return { restored: true, path, branch, branchRecreated: plan.branchRecreated }
}
