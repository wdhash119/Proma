/**
 * continue_delegation 等待语义测试
 *
 * 只测纯等待函数（不启动子会话）：完成、超时、取消三种收敛路径，
 * 以及 timer 与 abort 监听器的清理。
 */

import { describe, expect, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { waitForDelegationCompletion } from './agent-collaboration-utils'

/** 永不结束的 promise，模拟子会话仍在运行。 */
function pending(): Promise<void> {
  return new Promise<void>(() => {})
}

describe('continue_delegation 等待收敛', () => {
  test('Given 子会话完成 When 等待 Then 返回 settled', async () => {
    let resolve: () => void = () => {}
    const completion = new Promise<void>((r) => { resolve = r })

    const waiting = waitForDelegationCompletion(completion, { timeoutMs: 60_000 })
    resolve()

    await expect(waiting).resolves.toBe('settled')
  })

  test('Given 等待期间收到 abort When 等待 Then 立即返回 aborted', async () => {
    const controller = new AbortController()
    let outcome: string | undefined

    const waiting = waitForDelegationCompletion(pending(), {
      timeoutMs: 60_000,
      signal: controller.signal,
    }).then((value) => { outcome = value })

    controller.abort()
    await waiting

    expect(outcome).toBe('aborted')
    // 监听器必须清理，否则长驻会话会累积 abort 回调
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  test('Given signal 已经 abort When 等待 Then 不阻塞也不注册监听器', async () => {
    const controller = new AbortController()
    controller.abort()

    const startedAt = Date.now()
    const outcome = await waitForDelegationCompletion(pending(), {
      timeoutMs: 60_000,
      signal: controller.signal,
    })

    expect(outcome).toBe('aborted')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  test('Given 子会话超过等待上限 When 等待 Then 返回 timeout 并清理定时器', async () => {
    const realClearTimeout = globalThis.clearTimeout
    let cleared = 0
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared += 1
      return realClearTimeout(handle)
    }) as typeof clearTimeout

    try {
      const outcome = await waitForDelegationCompletion(pending(), { timeoutMs: 10 })

      expect(outcome).toBe('timeout')
      expect(cleared).toBeGreaterThan(0)
    } finally {
      globalThis.clearTimeout = realClearTimeout
    }
  })

  test('Given 子会话已完成 When 等待 Then 定时器与监听器都不残留', async () => {
    const controller = new AbortController()
    const realClearTimeout = globalThis.clearTimeout
    let cleared = 0
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared += 1
      return realClearTimeout(handle)
    }) as typeof clearTimeout

    try {
      const outcome = await waitForDelegationCompletion(Promise.resolve(), {
        timeoutMs: 60_000,
        signal: controller.signal,
      })

      expect(outcome).toBe('settled')
      expect(cleared).toBeGreaterThan(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      globalThis.clearTimeout = realClearTimeout
    }
  })

  test('Given 未提供 signal When 等待完成 Then 正常返回 settled', async () => {
    await expect(waitForDelegationCompletion(Promise.resolve(), { timeoutMs: 60_000 }))
      .resolves.toBe('settled')
  })
})
