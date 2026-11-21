import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  isTurnEndEvent,
  shouldDiscoverAfterTurn,
  TURN_DISCOVERY_DEBOUNCE_MS,
  TurnDiscoveryScheduler,
} from './change-request-turn-discovery'

describe('轮次结束发现时机', () => {
  test('Given 会话已有绑定 When 判断 Then 不管 cwd 在哪都刷新', () => {
    expect(shouldDiscoverAfterTurn({
      hasBindings: true,
      repositoryRoot: '/repo/.worktrees/feat',
      projectRoot: '/repo',
    })).toBe(true)

    // 仓库都没识别出来时，已有绑定仍值得刷新一次。
    expect(shouldDiscoverAfterTurn({ hasBindings: true, repositoryRoot: null, projectRoot: null })).toBe(true)
  })

  test('Given 尚无绑定且 cwd 就是项目根 When 判断 Then 触发发现', () => {
    expect(shouldDiscoverAfterTurn({
      hasBindings: false,
      repositoryRoot: '/repo',
      projectRoot: '/repo',
    })).toBe(true)
  })

  test('Given 尚无绑定且 cwd 不是项目根 When 判断 Then 不发现，避免绑定无关分支的 PR', () => {
    expect(shouldDiscoverAfterTurn({
      hasBindings: false,
      repositoryRoot: '/repo',
      projectRoot: '/other-project',
    })).toBe(false)

    // 会话留在工作台里：仓库根能识别，但项目根是另一处，同样不发现。
    expect(shouldDiscoverAfterTurn({
      hasBindings: false,
      repositoryRoot: '/repo',
      projectRoot: '/repo/sub-project',
    })).toBe(false)
  })

  test('Given 路径写法不同但指向同一目录 When 判断 Then 视为同一项目', () => {
    const root = resolve('/repo/app')
    expect(shouldDiscoverAfterTurn({
      hasBindings: false,
      repositoryRoot: join(root, '.'),
      projectRoot: root,
    })).toBe(true)
  })

  test('Given 缺少仓库根或项目根 When 判断 Then 不发现', () => {
    expect(shouldDiscoverAfterTurn({ hasBindings: false, repositoryRoot: null, projectRoot: '/repo' })).toBe(false)
    expect(shouldDiscoverAfterTurn({ hasBindings: false, repositoryRoot: '/repo', projectRoot: null })).toBe(false)
    expect(shouldDiscoverAfterTurn({ hasBindings: false, repositoryRoot: null, projectRoot: null })).toBe(false)
  })
})

describe('轮次结束事件判断', () => {
  test('Given run_completed 或 run_stopped When 判断 Then 视为轮次结束', () => {
    expect(isTurnEndEvent({ type: 'run_completed' })).toBe(true)
    expect(isTurnEndEvent({ type: 'run_stopped' })).toBe(true)
  })

  test('Given 其它事件或空值 When 判断 Then 不算轮次结束', () => {
    for (const event of [{ type: 'run_started' }, { type: 'title_updated' }, { type: 'run_resumed' }, {}, undefined, null]) {
      expect(isTurnEndEvent(event)).toBe(false)
    }
  })
})

describe('发现调度器', () => {
  test('Given 连续两轮结束 When 调度 Then 只执行最后一次', async () => {
    const runs: string[] = []
    const scheduler = new TurnDiscoveryScheduler({ debounceMs: 5, run: (id) => runs.push(id) })

    scheduler.schedule('s1')
    scheduler.schedule('s1')
    scheduler.schedule('s1')
    expect(scheduler.hasPending('s1')).toBe(true)

    await new Promise((r) => setTimeout(r, 30))

    expect(runs).toEqual(['s1'])
    expect(scheduler.hasPending('s1')).toBe(false)
    scheduler.cancelAll()
  })

  test('Given 两个会话 When 调度 Then 各自独立触发', async () => {
    const runs: string[] = []
    const scheduler = new TurnDiscoveryScheduler({ debounceMs: 5, run: (id) => runs.push(id) })

    scheduler.schedule('s1')
    scheduler.schedule('s2')
    await new Promise((r) => setTimeout(r, 30))

    expect(runs.sort()).toEqual(['s1', 's2'])
    scheduler.cancelAll()
  })

  test('Given 发现实现抛错 When 触发 Then 不外抛且状态清空', async () => {
    const scheduler = new TurnDiscoveryScheduler({
      debounceMs: 5,
      run: () => { throw new Error('boom') },
    })

    scheduler.schedule('s1')
    await new Promise((r) => setTimeout(r, 30))

    expect(scheduler.hasPending('s1')).toBe(false)
    scheduler.cancelAll()
  })

  test('Given 已取消 When 等待防抖结束 Then 不执行', async () => {
    const runs: string[] = []
    const scheduler = new TurnDiscoveryScheduler({ debounceMs: 10, run: (id) => runs.push(id) })

    scheduler.schedule('s1')
    scheduler.cancelAll()
    await new Promise((r) => setTimeout(r, 30))

    expect(runs).toEqual([])
  })

  test('Given 默认配置 When 检查 Then 防抖为 5 秒', () => {
    expect(TURN_DISCOVERY_DEBOUNCE_MS).toBe(5_000)
    const scheduler = new TurnDiscoveryScheduler({ run: () => {} })
    scheduler.schedule('s1')
    expect(scheduler.hasPending('s1')).toBe(true)
    scheduler.cancelAll()
    expect(scheduler.hasPending('s1')).toBe(false)
  })
})
