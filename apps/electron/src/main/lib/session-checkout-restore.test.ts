import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRestorableWorktreeRecord, planWorktreeRestore, readWorktreeHeadCommit, restoreWorktree } from './session-checkout-restore'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/** 建一个带首次提交的临时仓库，作为 worktree 恢复的真实场景。 */
function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-wt-'))
  created.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'README.md'), '# repo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

describe('worktree 记录校验', () => {
  test('Given 合法记录 When 校验 Then 通过', () => {
    expect(isRestorableWorktreeRecord({ path: '/repo/.worktrees/feat', branch: 'feat', baseCommit: 'abcdef1' })).toBe(true)
  })

  test('Given 相对路径或危险分支 When 校验 Then 拒绝', () => {
    expect(isRestorableWorktreeRecord({ path: 'relative/dir', branch: 'feat' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/wt', branch: '../evil' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/wt', branch: '-x' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/wt', branch: 'feat branch' })).toBe(false)
  })

  test('Given 分支缺失且无基准提交 When 计划 Then 拒绝并说明原因', () => {
    expect(planWorktreeRestore({ path: '/repo/wt', branch: 'feat', branchExists: false }))
      .toEqual({ ok: false, reason: 'branch-unavailable' })
  })

  test('Given 分支缺失但有基准提交 When 计划 Then 需要重建分支', () => {
    expect(planWorktreeRestore({ path: '/repo/wt', branch: 'feat', baseCommit: 'abcdef1', branchExists: false }))
      .toEqual({ ok: true, branchRecreated: true })
  })

  test('Given 分支仍存在 When 计划 Then 直接挂接', () => {
    expect(planWorktreeRestore({ path: '/repo/wt', branch: 'feat', branchExists: true }))
      .toEqual({ ok: true, branchRecreated: false })
  })
})

describe('恢复被删除的 worktree', () => {
  test('Given 目录被手动删除且分支仍在 When 恢复 Then 重建目录并可读取 HEAD', async () => {
    const repo = createRepo()
    const worktreePath = join(repo, '.worktrees', 'feat')
    git(repo, ['worktree', 'add', '-q', '-b', 'feat', worktreePath])
    const head = await readWorktreeHeadCommit(worktreePath)
    expect(head).toMatch(/^[0-9a-f]{7,64}$/i)

    // 模拟用户直接删掉目录，git 里仍登记着这个 worktree。
    rmSync(worktreePath, { recursive: true, force: true })
    expect(existsSync(worktreePath)).toBe(false)

    const result = await restoreWorktree({ path: worktreePath, branch: 'feat', baseCommit: head, repoPath: repo })

    expect(result).toEqual({ restored: true, path: worktreePath, branch: 'feat', branchRecreated: false })
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  test('Given 分支已删除但记录了基准提交 When 恢复 Then 按基准提交重建分支', async () => {
    const repo = createRepo()
    const worktreePath = join(repo, '.worktrees', 'gone')
    git(repo, ['worktree', 'add', '-q', '-b', 'gone', worktreePath])
    const baseCommit = await readWorktreeHeadCommit(worktreePath)
    git(repo, ['worktree', 'remove', '--force', worktreePath])
    git(repo, ['branch', '-D', 'gone'])

    const result = await restoreWorktree({ path: worktreePath, branch: 'gone', baseCommit, repoPath: repo })

    expect(result.branchRecreated).toBe(true)
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  test('Given 分支已删除且没有基准提交 When 恢复 Then 报错且不创建目录', async () => {
    const repo = createRepo()
    const worktreePath = join(repo, '.worktrees', 'lost')
    git(repo, ['worktree', 'add', '-q', '-b', 'lost', worktreePath])
    git(repo, ['worktree', 'remove', '--force', worktreePath])
    git(repo, ['branch', '-D', 'lost'])

    await expect(restoreWorktree({ path: worktreePath, branch: 'lost', repoPath: repo }))
      .rejects.toThrow('分支 lost 已删除且缺少基准提交')
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('Given 目录已存在 When 恢复 Then 提示无需恢复', async () => {
    const repo = createRepo()
    const worktreePath = join(repo, '.worktrees', 'alive')
    git(repo, ['worktree', 'add', '-q', '-b', 'alive', worktreePath])

    await expect(restoreWorktree({ path: worktreePath, branch: 'alive', repoPath: repo }))
      .rejects.toThrow('worktree 目录已存在')
  })
})
