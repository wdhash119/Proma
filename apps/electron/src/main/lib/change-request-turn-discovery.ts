/**
 * 轮次结束时的 PR 分支发现：时机判断与防抖调度（纯逻辑，不依赖 electron）。
 *
 * 一轮结束后是否值得自动发现 PR 有两种情况：
 * - 会话已有绑定：无论 cwd 在哪都刷新一次，PR 状态可能刚变化；
 * - 还没有绑定：只在会话 cwd 恰好是项目根时发现。用户选了 worktree 或留在会话
 *   工作台时，当前分支和项目根的主分支往往无关，自动绑定会拖进别的 PR。
 */

import { resolve } from 'node:path'

/** 一轮结束后稍等再发现：连续轮次只跑一次，避免每个 turn 都打 gh。 */
export const TURN_DISCOVERY_DEBOUNCE_MS = 5_000

interface ShouldDiscoverAfterTurnInput {
  /** 会话里已经有绑定。 */
  hasBindings: boolean
  /** 当前 cwd 所属 Git 仓库根；无法识别时为 null。 */
  repositoryRoot: string | null
  /** 工作区登记的项目根；托管项目或未设置时为 null。 */
  projectRoot: string | null
}

export function shouldDiscoverAfterTurn(input: ShouldDiscoverAfterTurnInput): boolean {
  if (input.hasBindings) return true
  if (!input.repositoryRoot || !input.projectRoot) return false
  return resolve(input.repositoryRoot) === resolve(input.projectRoot)
}

/** 只有轮次真正结束（完成或用户停止）才安排发现。 */
export function isTurnEndEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const type = (event as { type?: unknown }).type
  return type === 'run_completed' || type === 'run_stopped'
}

interface TurnDiscoverySchedulerOptions {
  /** 执行一次发现；异常会被吞掉，不影响 Agent 流。 */
  run: (sessionId: string) => void
  debounceMs?: number
}

/**
 * 按会话防抖的发现调度器。
 * 同一会话的新请求会顶掉旧请求，保证一轮密集的工具调用只触发一次 gh 查询。
 */
export class TurnDiscoveryScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private run: (sessionId: string) => void
  private debounceMs: number

  constructor(options: TurnDiscoverySchedulerOptions) {
    this.run = options.run
    this.debounceMs = options.debounceMs ?? TURN_DISCOVERY_DEBOUNCE_MS
  }

  schedule(sessionId: string): void {
    const existing = this.timers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId)
      try {
        this.run(sessionId)
      } catch (error) {
        console.warn('[变更请求] 轮次结束发现失败:', error)
      }
    }, this.debounceMs))
  }

  hasPending(sessionId: string): boolean {
    return this.timers.has(sessionId)
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
