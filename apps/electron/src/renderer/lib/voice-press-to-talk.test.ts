import { describe, expect, test } from 'bun:test'
import { PressToTalkController } from './voice-press-to-talk'

/** 让已排队的零延迟定时器与微任务全部执行完，避免测试真的等待长按阈值。 */
async function flushTimers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
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
  startCalls: string[]
  stopCalls: string[]
}

function createHarness(
  options: { delayMs?: number; movementThreshold?: number; startResults?: boolean[] } = {},
): Harness {
  const startCalls: string[] = []
  const stopCalls: string[] = []
  const startResults = options.startResults ?? []
  const controller = new PressToTalkController({
    start: async (token) => {
      startCalls.push(token)
      return startResults.length > 0 ? startResults.shift() === true : true
    },
    stop: async (token) => {
      stopCalls.push(token)
    },
    makeToken: () => `token-${startCalls.length + 1}`,
    delayMs: options.delayMs ?? 0,
    movementThreshold: options.movementThreshold ?? 8,
  })
  return { controller, startCalls, stopCalls }
}

describe('PressToTalkController 阈值与启动', () => {
  test('Given 按住超过阈值 When 定时器到点 Then 只调用一次 start', async () => {
    const { controller, startCalls, stopCalls } = createHarness()
    controller.down(1, 10, 10)
    await flushTimers()

    expect(startCalls).toEqual(['token-1'])
    expect(stopCalls).toEqual([])
    expect(controller.isPressing).toBe(true)
  })

  test('Given 阈值未到就松手 When 结束 Then 不调用 start', async () => {
    const { controller, startCalls, stopCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.finish(1)
    await flushTimers()

    expect(startCalls).toEqual([])
    expect(stopCalls).toEqual([])
    expect(controller.isPressing).toBe(false)
  })

  test('Given 按下未到阈值 When Esc 取消 Then 不调用 start', async () => {
    const { controller, startCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.cancelPending()
    await flushTimers()

    expect(startCalls).toEqual([])
    expect(controller.isPressing).toBe(false)
  })

  test('Given 鼠标未移动 When 到点 Then 正常启动', async () => {
    const { controller, startCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.move(1, 10, 10)
    await flushTimers()

    expect(startCalls).toEqual(['token-1'])
  })
})

describe('PressToTalkController 移动取消', () => {
  test('Given 位移超过阈值 When 移动 Then 取消且不启动', async () => {
    const { controller, startCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.move(1, 19, 10)
    await flushTimers()

    expect(startCalls).toEqual([])
    expect(controller.isPressing).toBe(false)
  })

  test('Given 位移在阈值内 When 移动 Then 仍然启动', async () => {
    const { controller, startCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.move(1, 15, 10)
    await flushTimers()

    expect(startCalls).toEqual(['token-1'])
  })

  test('Given 已启动 When 大幅移动 Then 不再取消会话', async () => {
    const { controller, startCalls, stopCalls } = createHarness()
    controller.down(1, 10, 10)
    await flushTimers()
    controller.move(1, 200, 200)

    expect(startCalls).toEqual(['token-1'])
    expect(stopCalls).toEqual([])
    expect(controller.isPressing).toBe(true)
  })
})

describe('PressToTalkController 重复按下与松手', () => {
  test('Given 已有长按会话 When 第二个 pointer 按下 Then 被忽略', async () => {
    const { controller, startCalls } = createHarness()
    controller.down(1, 10, 10)
    controller.down(2, 20, 20)
    await flushTimers()

    expect(startCalls).toEqual(['token-1'])
  })

  test('Given 启动后松手 When 结束 Then 用同一 token 调用一次 stop', async () => {
    const { controller, startCalls, stopCalls } = createHarness()
    controller.down(1, 10, 10)
    await flushTimers()
    controller.finish(1)
    await flushTimers()

    expect(startCalls).toEqual(['token-1'])
    expect(stopCalls).toEqual(['token-1'])
    expect(controller.isPressing).toBe(false)
  })

  test('Given 其他 pointer 松手 When 结束 Then 不影响当前会话', async () => {
    const { controller, stopCalls } = createHarness()
    controller.down(1, 10, 10)
    await flushTimers()
    controller.finish(2)

    expect(stopCalls).toEqual([])
    expect(controller.isPressing).toBe(true)
  })
})

describe('PressToTalkController 启动未完成时松手', () => {
  test('Given start 尚未返回就松手 When start 返回成功 Then 补发一次 stop', async () => {
    const stopCalls: string[] = []
    const deferred = createDeferredStart()
    const controller = new PressToTalkController({
      start: () => deferred.promise,
      stop: async (token) => {
        stopCalls.push(token)
      },
      makeToken: () => 'token-late',
      delayMs: 0,
    })

    controller.down(1, 10, 10)
    await flushTimers()
    // 此时 start 仍在进行中，松手不应立刻发 stop。
    controller.finish(1)
    expect(stopCalls).toEqual([])

    deferred.resolve(true)
    await flushTimers()

    expect(stopCalls).toEqual(['token-late'])
  })

  test('Given start 尚未返回就松手 When start 返回失败 Then 不发 stop', async () => {
    const stopCalls: string[] = []
    const deferred = createDeferredStart()
    const controller = new PressToTalkController({
      start: () => deferred.promise,
      stop: async (token) => {
        stopCalls.push(token)
      },
      makeToken: () => 'token-rejected',
      delayMs: 0,
    })

    controller.down(1, 10, 10)
    await flushTimers()
    controller.finish(1)
    deferred.resolve(false)
    await flushTimers()

    expect(stopCalls).toEqual([])
  })
})
