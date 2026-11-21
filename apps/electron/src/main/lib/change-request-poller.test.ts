import { describe, expect, test } from 'bun:test'
import type { ChangeRequestSnapshot } from '@proma/shared'
import {
  CLOSED_POLL_RETENTION_MS,
  DEFAULT_CHANGE_REQUEST_POLL_INTERVALS,
  ChangeRequestPoller,
  nextChangeRequestPollDelay,
  type PollTimers,
} from './change-request-poller'
import type { ChangeRequestFetchResult } from './change-request-store'

function snapshot(overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    title: 'PR',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'main',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    checks: [],
    fetchedAt: 0,
    ...overrides,
  }
}

const intervals = DEFAULT_CHANGE_REQUEST_POLL_INTERVALS

describe('轮询节奏', () => {
  test('Given check 仍在跑 When 计算延迟 Then 用活跃间隔', () => {
    const delay = nextChangeRequestPollDelay(
      { snapshot: snapshot({ mergeable: 'UNKNOWN' }) },
      0,
      intervals,
    )
    expect(delay).toBe(intervals.activeMs)
  })

  test('Given 检查全部完成且可合并 When 计算延迟 Then 放慢到空闲间隔', () => {
    const delay = nextChangeRequestPollDelay({ snapshot: snapshot() }, 0, intervals)
    expect(delay).toBe(intervals.idleMs)
  })

  test('Given 已合并 When 计算延迟 Then 停止轮询', () => {
    expect(nextChangeRequestPollDelay({ snapshot: snapshot({ state: 'MERGED' }) }, 0, intervals)).toBeUndefined()
  })

  test('Given 已关闭 When 计算延迟 Then 低频跟进，超过保留期后停止', () => {
    expect(nextChangeRequestPollDelay({ snapshot: snapshot({ state: 'CLOSED' }) }, 0, intervals)).toBe(intervals.closedMs)
    expect(nextChangeRequestPollDelay({ snapshot: snapshot({ state: 'CLOSED' }) }, 0, intervals, CLOSED_POLL_RETENTION_MS))
      .toBeUndefined()
  })

  test('Given 连续失败 When 计算延迟 Then 指数退避且不超过上限', () => {
    const error: ChangeRequestFetchResult = { error: 'gh failed' }
    expect(nextChangeRequestPollDelay(error, 1, intervals)).toBe(intervals.activeMs)
    expect(nextChangeRequestPollDelay(error, 3, intervals)).toBe(intervals.activeMs * 4)
    expect(nextChangeRequestPollDelay(error, 20, intervals)).toBe(intervals.maxBackoffMs)
  })
})

/** 手动推进定时器，避免测试依赖真实时钟。 */
function createTimers(): { timers: PollTimers; advance: (ms: number) => Promise<void>; now: () => number } {
  let current = 0
  let scheduled: Array<{ at: number; handler: () => void; handle: ReturnType<typeof setTimeout> }> = []
  const timers: PollTimers = {
    now: () => current,
    setTimeout: (handler, delayMs) => {
      const handle = setTimeout(() => {}, 0)
      clearTimeout(handle)
      scheduled.push({ at: current + delayMs, handler, handle })
      return handle
    },
    clearTimeout: (handle) => {
      scheduled = scheduled.filter((item) => item.handle !== handle)
    },
  }
  const advance = async (ms: number): Promise<void> => {
    current += ms
    const due = scheduled.filter((item) => item.at <= current)
    scheduled = scheduled.filter((item) => item.at > current)
    for (const item of due) item.handler()
    // 让 fetchOne 的微任务与后续 schedule 跑完。
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { timers, advance, now: () => current }
}

describe('轮询器', () => {
  test('Given 两条 PR When 同步 Then 都进入关注列表', () => {
    const { timers } = createTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => [],
      notify: () => {},
      timers,
    })

    poller.sync([
      { sessionId: 's1', urls: ['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2'] },
    ])

    expect(poller.watchedUrls().sort()).toEqual([
      'https://github.com/a/b/pull/1',
      'https://github.com/a/b/pull/2',
    ])
    poller.dispose()
  })

  test('Given 会话取消绑定 When 同步 Then 停止关注', () => {
    const { timers } = createTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => [],
      notify: () => {},
      timers,
    })

    poller.sync([{ sessionId: 's1', urls: ['https://github.com/a/b/pull/1'] }])
    poller.sync([])

    expect(poller.watchedUrls()).toEqual([])
    poller.dispose()
  })

  test('Given 到期的 PR When 轮询 Then 写入结果并通知受影响会话', async () => {
    const { timers, advance } = createTimers()
    const fetched: string[] = []
    const notified: string[][] = []
    const poller = new ChangeRequestPoller({
      fetch: async (url) => {
        fetched.push(url)
        return { snapshot: snapshot({ title: 'new' }) }
      },
      settle: () => ['s1'],
      notify: (ids) => notified.push(ids),
      timers,
    })

    poller.sync([{ sessionId: 's1', urls: ['https://github.com/a/b/pull/1'] }])
    await poller.pollDue()
    await advance(0)

    expect(fetched).toEqual(['https://github.com/a/b/pull/1'])
    expect(notified).toEqual([['s1']])
    poller.dispose()
  })

  test('Given 读取失败 When 轮询 Then 记录错误并按退避重试', async () => {
    const { timers } = createTimers()
    let attempts = 0
    const results: ChangeRequestFetchResult[] = []
    const poller = new ChangeRequestPoller({
      fetch: async () => {
        attempts += 1
        return { error: 'gh 未登录' }
      },
      settle: (_url, result) => {
        results.push(result)
        return ['s1']
      },
      notify: () => {},
      timers,
    })

    poller.sync([{ sessionId: 's1', urls: ['https://github.com/a/b/pull/1'] }])
    await poller.pollDue()

    expect(attempts).toBe(1)
    expect(results[0]).toEqual({ error: 'gh 未登录' })
    // 失败后退避；不会在同一时刻重试。
    expect(poller.delayOf('https://github.com/a/b/pull/1')).toBe(intervals.activeMs)
    poller.dispose()
  })

  test('Given 手动刷新 When 指定未关联的 URL Then 直接返回可读错误', async () => {
    const { timers } = createTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => [],
      notify: () => {},
      timers,
    })

    const results = await poller.refreshAndWait('s1', 'https://github.com/a/b/pull/9')

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ error: '该变更请求未关联或已隐藏，请重新关联后刷新。' })
    poller.dispose()
  })

  test('Given 已停止 When 同步 Then 不再接受新关注', () => {
    const { timers } = createTimers()
    const poller = new ChangeRequestPoller({
      fetch: async () => ({ snapshot: snapshot() }),
      settle: () => [],
      notify: () => {},
      timers,
    })

    poller.dispose()
    poller.sync([{ sessionId: 's1', urls: ['https://github.com/a/b/pull/1'] }])

    expect(poller.watchedUrls()).toEqual([])
  })
})
