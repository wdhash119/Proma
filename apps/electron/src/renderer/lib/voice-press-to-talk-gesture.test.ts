import { describe, expect, test } from 'bun:test'
import { PressToTalkController } from './voice-press-to-talk'
import {
  beginPressGesture,
  consumePressGesture,
  createPressToTalkGestureState,
  endPressGesture,
  shouldSuppressPressToTalkClick,
} from './voice-press-to-talk-gesture'

/** 让零延迟定时器与已排队的微任务全部执行完。 */
async function flushTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  await Promise.resolve()
  await Promise.resolve()
}

interface DeferredStart {
  promise: Promise<boolean>
  resolve: (started: boolean) => void
}

function createDeferredStart(): DeferredStart {
  let resolve: (started: boolean) => void = () => {}
  const promise = new Promise<boolean>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface Harness {
  controller: PressToTalkController
  gesture: ReturnType<typeof createPressToTalkGestureState>
  stopCalls: string[]
  deferred: DeferredStart
}

/**
 * 复刻 hook 的真实时序：越过阈值 → 同步消费手势 → 发起 start（挂起）→ 松手 arm 抑制。
 */
function createDeferredHarness(): Harness {
  const deferred = createDeferredStart()
  const gesture = createPressToTalkGestureState()
  const stopCalls: string[] = []
  const controller = new PressToTalkController({
    start: async () => {
      // 与 use-voice-press-to-talk 一致：await 之前消费手势。
      consumePressGesture(gesture)
      return deferred.promise
    },
    stop: async (token) => {
      stopCalls.push(token)
    },
    makeToken: () => 'token-late',
    delayMs: 0,
  })
  return { controller, gesture, stopCalls, deferred }
}

describe('按住说话手势消费与 click 抑制', () => {
  test('Given 越过阈值但 start 挂起 When 松手后 click Then 抑制 click，迟到成功后补发 stop', async () => {
    const { controller, gesture, stopCalls, deferred } = createDeferredHarness()

    beginPressGesture(gesture)
    controller.down(1, 10, 10)
    await flushTimers()
    // start 尚未 resolve，用户松手。
    controller.finish(1)
    endPressGesture(gesture, 1000)

    // 浏览器随后补发 click：必须被抑制，不进入普通 toggle。
    expect(shouldSuppressPressToTalkClick(gesture, 1001)).toBe(true)
    // 抑制只消费一次，不会误伤后续真实点击。
    expect(shouldSuppressPressToTalkClick(gesture, 1002)).toBe(false)
    expect(stopCalls).toEqual([])

    deferred.resolve(true)
    await flushTimers()

    // 迟到建立的会话被同一个 token 收尾，不会继续录音。
    expect(stopCalls).toEqual(['token-late'])
  })

  test('Given 越过阈值但 start 挂起 When 松手后 click 且迟到失败 Then 抑制 click 且不发 stop', async () => {
    const { controller, gesture, stopCalls, deferred } = createDeferredHarness()

    beginPressGesture(gesture)
    controller.down(1, 10, 10)
    await flushTimers()
    controller.finish(1)
    endPressGesture(gesture, 2000)

    expect(shouldSuppressPressToTalkClick(gesture, 2001)).toBe(true)

    deferred.resolve(false)
    await flushTimers()

    expect(stopCalls).toEqual([])
    expect(controller.isPressing).toBe(false)
  })

  test('Given 阈值未到就松手 When click Then 不抑制，保持普通 toggle', async () => {
    const gesture = createPressToTalkGestureState()
    const stopCalls: string[] = []
    const controller = new PressToTalkController({
      start: async () => {
        consumePressGesture(gesture)
        return true
      },
      stop: async (token) => {
        stopCalls.push(token)
      },
      delayMs: 1000,
    })

    beginPressGesture(gesture)
    controller.down(1, 10, 10)
    controller.finish(1)
    endPressGesture(gesture, 3000)

    expect(shouldSuppressPressToTalkClick(gesture, 3001)).toBe(false)
    expect(stopCalls).toEqual([])
  })

  test('Given 抑制窗口已过期 When click Then 不再抑制', () => {
    const gesture = createPressToTalkGestureState()
    beginPressGesture(gesture)
    consumePressGesture(gesture)
    endPressGesture(gesture, 0)

    expect(shouldSuppressPressToTalkClick(gesture, 800)).toBe(false)
    expect(shouldSuppressPressToTalkClick(gesture, 799)).toBe(true)
  })

  test('Given 新的一次按下 When 开始手势 Then 清空上一次的消费与抑制', () => {
    const gesture = createPressToTalkGestureState()
    consumePressGesture(gesture)
    endPressGesture(gesture, 0)

    beginPressGesture(gesture)

    expect(shouldSuppressPressToTalkClick(gesture, 1)).toBe(false)
  })
})
