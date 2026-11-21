/**
 * 从会话检出日志恢复被删除的 worktree。
 *
 * 只重建日志里记录过的路径与分支：先 prune 掉失效登记，再判断分支是否还在；
 * 分支已被删除时用选择当时的 HEAD 提交重建分支，避免把无关提交带进来。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { RestoreSessionWorktreeResult } from '@proma/shared'

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

  // 目录可能被手动删除，先清掉 git 里的失效登记，否则 add 会因为路径被占用而失败。
  const prune = await git(['worktree', 'prune'], repoPath, options.signal)
  if (!prune.ok) throw new Error(`清理 worktree 登记失败：${prune.stderr}`)

  const branchCheck = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, options.signal)
  const plan = planWorktreeRestore({ path, branch, baseCommit, branchExists: branchCheck.ok })
  if (!plan.ok) {
    throw new Error(plan.reason === 'branch-unavailable'
      ? `分支 ${branch} 已删除且缺少基准提交，无法恢复`
      : 'worktree 记录无效，不能恢复')
  }

  const add = plan.branchRecreated
    ? await git(['worktree', 'add', '-b', branch, path, baseCommit!], repoPath, options.signal)
    : await git(['worktree', 'add', path, branch], repoPath, options.signal)
  if (!add.ok) throw new Error(`恢复 worktree 失败：${add.stderr}`)

  return { restored: true, path, branch, branchRecreated: plan.branchRecreated }
}
