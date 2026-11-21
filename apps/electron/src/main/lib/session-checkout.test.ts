import { describe, expect, test } from 'bun:test'
import { appendCheckoutEntry, checkoutFromActiveWorktree, isCurrentCheckout, listRestorableWorktrees, resolveSessionCheckout } from './session-checkout'
import type { SessionCheckoutEntry } from '@proma/shared'

const worktree: SessionCheckoutEntry = {
  kind: 'worktree',
  path: '/repo/.worktrees/feature-a',
  mainRepoRoot: '/repo',
  branch: 'feature-a',
  baseCommit: 'abcdef1',
  since: 200,
}

function existingDirectories(paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path)
}

describe('会话检出解析', () => {
  test('Given 最新 worktree 存在 When 解析 Then 直接使用它', () => {
    const resolved = resolveSessionCheckout({
      history: [{ kind: 'workbench', path: '/workbench', since: 100 }, worktree],
      agentCwdMode: 'session',
      workbenchPath: '/workbench',
      isDirectory: existingDirectories(['/workbench', worktree.path]),
    })

    expect(resolved?.path).toBe(worktree.path)
    expect(resolved?.fellBack).toBe(false)
  })

  test('Given worktree 已被删除 When 解析 Then 回退上一级目录而不是让会话不可用', () => {
    const resolved = resolveSessionCheckout({
      history: [{ kind: 'workbench', path: '/workbench', since: 100 }, worktree],
      agentCwdMode: 'session',
      workbenchPath: '/workbench',
      isDirectory: existingDirectories(['/workbench']),
    })

    expect(resolved?.path).toBe('/workbench')
    expect(resolved?.kind).toBe('workbench')
    expect(resolved?.fellBack).toBe(true)
  })

  test('Given 日志全失效 When 解析 Then 回退默认检出并标记 fellBack', () => {
    const resolved = resolveSessionCheckout({
      history: [worktree],
      agentCwdMode: 'project',
      projectPath: '/project',
      isDirectory: existingDirectories(['/project']),
    })

    expect(resolved?.path).toBe('/project')
    expect(resolved?.kind).toBe('project')
    expect(resolved?.fellBack).toBe(true)
  })

  test('Given 旧数据只有 activeWorktree When 解析 Then 仍以该 worktree 为 cwd', () => {
    const resolved = resolveSessionCheckout({
      activeWorktree: { path: '/repo/.worktrees/legacy', mainRepoRoot: '/repo', branch: 'legacy', selectedAt: 1 },
      agentCwdMode: 'session',
      workbenchPath: '/workbench',
      isDirectory: existingDirectories(['/repo/.worktrees/legacy']),
    })

    expect(resolved?.path).toBe('/repo/.worktrees/legacy')
    expect(resolved?.kind).toBe('worktree')
  })

  test('Given 什么都没有 When 解析 Then 返回 null', () => {
    expect(resolveSessionCheckout({ isDirectory: () => false })).toBeNull()
  })
})

describe('检出日志维护', () => {
  test('Given 已记录同路径 When 再次追加 Then 去重并放到末尾', () => {
    const first = appendCheckoutEntry(undefined, { kind: 'workbench', path: '/w', since: 1 })
    const second = appendCheckoutEntry(first, { kind: 'workbench', path: '/w', since: 2 })

    expect(second).toEqual([{ kind: 'workbench', path: '/w', since: 2 }])
  })

  test('Given 记录超过上限 When 追加 Then 丢弃最旧记录', () => {
    let history: SessionCheckoutEntry[] = []
    for (let index = 0; index < 25; index += 1) {
      history = appendCheckoutEntry(history, { kind: 'worktree', path: `/repo/wt-${index}`, since: index })
    }

    expect(history).toHaveLength(20)
    expect(history[0]?.path).toBe('/repo/wt-5')
  })

  test('Given 最新一条是当前路径 When 判断 Then 识别为当前检出', () => {
    const history = appendCheckoutEntry(undefined, worktree)
    expect(isCurrentCheckout(history, worktree.path)).toBe(true)
    expect(isCurrentCheckout(history, '/repo/other')).toBe(false)
  })

  test('Given worktree 选择 When 生成记录 Then 带上主仓库与分支', () => {
    expect(checkoutFromActiveWorktree({ path: '/repo/wt', mainRepoRoot: '/repo', branch: 'feat', selectedAt: 9 }, 'abc1234'))
      .toEqual({ kind: 'worktree', path: '/repo/wt', mainRepoRoot: '/repo', branch: 'feat', baseCommit: 'abc1234', since: 9 })
  })
})

describe('可恢复 worktree 列表', () => {
  test('Given 目录已删除 When 列出 Then 只包含 worktree 类型且缺失的目录', () => {
    const history: SessionCheckoutEntry[] = [
      { kind: 'workbench', path: '/workbench', since: 1 },
      worktree,
      { kind: 'worktree', path: '/repo/wt-alive', mainRepoRoot: '/repo', branch: 'alive', since: 300 },
    ]

    const restorable = listRestorableWorktrees(history, existingDirectories(['/repo/wt-alive']))

    expect(restorable.map((entry) => entry.path)).toEqual([worktree.path])
  })

  test('Given 缺少分支或主仓库 When 列出 Then 不进入可恢复列表', () => {
    const history: SessionCheckoutEntry[] = [
      { kind: 'worktree', path: '/repo/wt-x', since: 1 },
      { kind: 'worktree', path: '/repo/wt-y', branch: 'y', since: 2 },
    ]

    expect(listRestorableWorktrees(history, () => false)).toEqual([])
  })
})
