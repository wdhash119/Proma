/**
 * 变更请求轮询器。
 *
 * 每条 PR 独立调度：全部 check 通过且可合并时放慢到空闲间隔，
 * 有 pending check 或 mergeable 未知时按活跃间隔跟进，失败按指数退避，
 * 已合并的停止轮询，已关闭的只在保留期内低频看一眼。
 */

import { isCheckPending } from '@proma/shared'
import type { ChangeRequestFetchResult } from './change-request-store'

interface ChangeRequestPollIntervals {
  activeMs: number
  idleMs: number
  closedMs: number
  maxBackoffMs: number
  maxConcurrent: number
}

export const DEFAULT_CHANGE_REQUEST_POLL_INTERVALS: ChangeRequestPollIntervals = {
  activeMs: 30_000,
  idleMs: 120_000,
  closedMs: 300_000,
  maxBackoffMs: 900_000,
  maxConcurrent: 3,
}

/** 已关闭的 PR 仍保留轮询 7 天，之后不再跟进。 */
export const CLOSED_POLL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 计算下一次轮询延迟；返回 undefined 表示停止轮询。 */
export function nextChangeRequestPollDelay(
  result: ChangeRequestFetchResult,
  failures: number,
  intervals: ChangeRequestPollIntervals,
  closedForMs = 0,
): number | undefined {
  if (closedForMs >= CLOSED_POLL_RETENTION_MS) return undefined
  if ('error' in result) {
    return Math.min(intervals.maxBackoffMs, intervals.activeMs * 2 ** Math.max(0, failures - 1))
  }
  const { snapshot } = result
  if (snapshot.state === 'MERGED') return undefined
  if (snapshot.state === 'CLOSED') return intervals.closedMs
  const unstable = (snapshot.mergeable || '').toUpperCase() === 'UNKNOWN'
    || snapshot.checks.some(isCheckPending)
  return unstable ? intervals.activeMs : intervals.idleMs
}

interface ChangeRequestPollerOptions {
  /** 读取单条 PR 的最新状态；失败时返回 { error }。 */
  fetch: (url: string) => Promise<ChangeRequestFetchResult>
  /** 写入结果，返回受影响会话 ID。 */
  settle: (url: string, result: ChangeRequestFetchResult) => string[]
  /** 通知渲染进程刷新。 */
  notify: (sessionIds: string[]) => void
  intervals?: Partial<ChangeRequestPollIntervals>
  timers?: PollTimers
}

export interface PollTimers {
  now: () => number
  setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

interface Watch {
  url: string
  sessions: Set<string>
  dueAt: number | undefined
  failures: number
  closedSince?: number
  generation: number
  waiters: Array<{ generation: number; resolve: (result: ChangeRequestFetchResult) => void }>
}

const defaultTimers: PollTimers = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

export class ChangeRequestPoller {
  private watches = new Map<string, Watch>()
  private inFlight = new Set<string>()
  private intervals: ChangeRequestPollIntervals
  private timers: PollTimers
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private options: ChangeRequestPollerOptions

  constructor(options: ChangeRequestPollerOptions) {
    this.options = options
    this.intervals = { ...DEFAULT_CHANGE_REQUEST_POLL_INTERVALS, ...options.intervals }
    this.timers = options.timers ?? defaultTimers
  }

  /** 用最新的会话绑定整体替换成员关系；不存在的会话不再轮询。 */
  sync(sessions: Array<{ sessionId: string; urls: string[] }>): void {
    if (this.disposed) return
    const next = new Map<string, Set<string>>()
    for (const session of sessions) {
      for (const url of session.urls) {
        const owners = next.get(url) ?? new Set<string>()
        owners.add(session.sessionId)
        next.set(url, owners)
      }
    }

    for (const [url, watch] of [...this.watches]) {
      const owners = next.get(url)
      if (!owners || owners.size === 0) {
        this.watches.delete(url)
        for (const waiter of watch.waiters.splice(0)) {
          waiter.resolve({ error: '变更请求关联已移除。' })
        }
        continue
      }
      watch.sessions = new Set(owners)
    }

    for (const [url, owners] of next) {
      if (this.watches.has(url)) continue
      this.watches.set(url, {
        url,
        sessions: new Set(owners),
        dueAt: this.timers.now(),
        failures: 0,
        generation: 0,
        waiters: [],
      })
    }
    this.schedule()
  }

  /** 立即刷新某个会话的绑定；省略 sessionId 时刷新全部。 */
  refresh(sessionId?: string): void {
    const now = this.timers.now()
    for (const watch of this.watches.values()) {
      if (sessionId && !watch.sessions.has(sessionId)) continue
      watch.dueAt = now
    }
    this.schedule()
  }

  refreshUrl(url: string): void {
    const watch = this.watches.get(url)
    if (!watch) return
    watch.dueAt = this.timers.now()
    this.schedule()
  }

  /**
   * 等待一次「本次请求之后开始」的读取结果。
   * 手动刷新只等自己那次，不与后台轮询的同一 URL 请求互相阻塞。
   */
  async refreshAndWait(sessionId: string, url?: string): Promise<ChangeRequestFetchResult[]> {
    const watches = [...this.watches.values()].filter((watch) => (
      watch.sessions.has(sessionId) && (!url || watch.url === url)
    ))
    if (url && watches.length === 0) {
      return [{ error: '该变更请求未关联或已隐藏，请重新关联后刷新。' }]
    }
    const results = watches.map((watch) => new Promise<ChangeRequestFetchResult>((resolve) => {
      watch.waiters.push({ generation: watch.generation + 1, resolve })
      watch.dueAt = this.timers.now()
    }))
    this.schedule()
    void this.pollDue()
    return Promise.all(results)
  }

  /** 供测试与启动自检使用：当前绑定的 URL。 */
  watchedUrls(): string[] {
    return [...this.watches.keys()]
  }

  /** 某条 URL 距离下次轮询的毫秒数；未注册或已停止时为 undefined。 */
  delayOf(url: string): number | undefined {
    const watch = this.watches.get(url)
    if (!watch || watch.dueAt === undefined) return undefined
    return Math.max(0, watch.dueAt - this.timers.now())
  }

  /** 执行所有已到期的查询，返回本轮实际查询的 URL。 */
  async pollDue(): Promise<string[]> {
    if (this.disposed) return []
    const now = this.timers.now()
    const due = [...this.watches.values()]
      .filter((watch) => !this.inFlight.has(watch.url) && watch.dueAt !== undefined && watch.dueAt <= now)
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))

    const batch = due.slice(0, Math.max(0, this.intervals.maxConcurrent - this.inFlight.size))
    if (batch.length === 0) {
      this.schedule()
      return []
    }

    for (const watch of batch) {
      watch.dueAt = undefined
      watch.generation += 1
      this.inFlight.add(watch.url)
    }

    await Promise.all(batch.map((watch) => this.fetchOne(watch)))
    this.schedule()
    return batch.map((watch) => watch.url)
  }

  dispose(): void {
    this.disposed = true
    for (const watch of this.watches.values()) {
      for (const waiter of watch.waiters.splice(0)) {
        waiter.resolve({ error: '变更请求服务已停止。' })
      }
    }
    this.watches.clear()
    this.inFlight.clear()
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async fetchOne(watch: Watch): Promise<void> {
    const generation = watch.generation
    let result: ChangeRequestFetchResult
    try {
      result = await this.options.fetch(watch.url)
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) }
    }

    this.inFlight.delete(watch.url)
    if (this.disposed || this.watches.get(watch.url) !== watch) return

    let affected: string[]
    try {
      affected = this.options.settle(watch.url, result)
    } catch (error) {
      console.warn('[变更请求] 写入轮询结果失败:', error)
      affected = []
      result = { error: '无法保存变更请求状态，请检查本地会话文件。' }
    }

    const now = this.timers.now()
    if ('error' in result) watch.failures += 1
    else watch.failures = 0

    if ('snapshot' in result && result.snapshot.state === 'CLOSED') {
      watch.closedSince ??= now
    } else if (!('error' in result)) {
      watch.closedSince = undefined
    }

    const closedForMs = watch.closedSince === undefined ? 0 : Math.max(0, now - watch.closedSince)
    const delay = nextChangeRequestPollDelay(result, watch.failures, this.intervals, closedForMs)
    watch.dueAt = watch.dueAt ?? (delay === undefined ? undefined : this.timers.now() + delay)

    const ready = watch.waiters.filter((waiter) => waiter.generation <= generation)
    watch.waiters = watch.waiters.filter((waiter) => waiter.generation > generation)
    for (const waiter of ready) waiter.resolve(result)

    if (affected.length > 0) {
      try {
        this.options.notify(affected)
      } catch (error) {
        console.warn('[变更请求] 推送状态失败:', error)
      }
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.disposed || this.inFlight.size >= this.intervals.maxConcurrent) return

    let next: number | undefined
    for (const watch of this.watches.values()) {
      if (watch.dueAt === undefined || this.inFlight.has(watch.url)) continue
      next = next === undefined ? watch.dueAt : Math.min(next, watch.dueAt)
    }
    if (next === undefined) return

    const delay = Math.max(0, next - this.timers.now())
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      void this.pollDue()
    }, delay)
  }
}
