import { describe, expect, test } from 'bun:test'
import { ComputerUseDriverError } from './computer-use-driver'
import {
  ComputerUsePreviewService,
  type ComputerUsePreviewCaptureInput,
  type ComputerUsePreviewWindowTarget,
} from './computer-use-preview'

const SESSION_ID = 'session-1'
const OWNER = 'owner-1'
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

interface PreviewHarness {
  service: ComputerUsePreviewService
  captures: ComputerUsePreviewCaptureInput[]
  releases: string[]
  activations: ComputerUsePreviewWindowTarget[]
  /** 替换下一次采集的行为。 */
  setCapture: (next: (input: ComputerUsePreviewCaptureInput) => Promise<string>) => void
}

function createHarness(): PreviewHarness {
  const captures: ComputerUsePreviewCaptureInput[] = []
  const releases: string[] = []
  const activations: ComputerUsePreviewWindowTarget[] = []
  let captureImpl: (input: ComputerUsePreviewCaptureInput) => Promise<string> = async () => PNG_DATA_URL

  const service = new ComputerUsePreviewService({
    capture: async (input) => {
      captures.push(input)
      return captureImpl(input)
    },
    release: async (previewId) => {
      releases.push(previewId)
    },
    activate: async (target) => {
      activations.push(target)
    },
  })

  return {
    service,
    captures,
    releases,
    activations,
    setCapture: (next) => { captureImpl = next },
  }
}

function showWindow(service: ComputerUsePreviewService, owner = OWNER, pid = 100, windowId = 200): void {
  service.show(owner, SESSION_ID, { action: 'show', target: 'window', pid, windowId, label: '记事本' })
}

describe('预览状态机', () => {
  test('Given 登记窗口目标 When 轮询采集 Then 返回运行中状态与画面', async () => {
    const harness = createHarness()
    showWindow(harness.service)

    const state = await harness.service.get(SESSION_ID, true)

    expect(state?.status).toBe('running')
    expect(state?.target).toBe('window')
    expect(state?.transport).toBe('snapshot')
    expect(state?.label).toBe('记事本')
    expect(state?.image).toBe(PNG_DATA_URL)
    expect(typeof state?.capturedAt).toBe('number')
    expect(harness.captures).toHaveLength(1)
    expect(harness.captures[0]?.pid).toBe(100)
    expect(harness.captures[0]?.windowId).toBe(200)
  })

  test('Given 未登记预览 When 轮询 Then 返回 null 且不采集', async () => {
    const harness = createHarness()

    expect(await harness.service.get(SESSION_ID, true)).toBeNull()
    expect(harness.captures).toHaveLength(0)
  })

  test('Given 桌面目标且未给 label When 登记 Then 使用「桌面」作为默认标题', async () => {
    const harness = createHarness()
    harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'desktop' })

    const state = await harness.service.get(SESSION_ID, true)

    expect(state?.label).toBe('桌面')
    expect(state?.target).toBe('desktop')
    expect(harness.captures[0]?.target).toBe('desktop')
  })

  test('Given label 超长 When 登记 Then 截断到 100 字符', () => {
    const harness = createHarness()
    harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'desktop', label: '窗'.repeat(150) })

    return harness.service.get(SESSION_ID, false).then((state) => {
      expect(state?.label).toHaveLength(100)
    })
  })

  test('Given 缺少 target When 登记 Then 抛出中文提示', () => {
    const harness = createHarness()

    expect(() => harness.service.show(OWNER, SESSION_ID, { action: 'show' })).toThrow('请选择窗口或桌面')
  })

  test('Given 窗口目标缺少有效 pid When 登记 Then 拒绝并要求来自 list_windows', () => {
    const harness = createHarness()

    expect(() => harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'window', pid: 0, windowId: 2 }))
      .toThrow('窗口预览需要从 list_windows 获取有效的 pid 和 windowId')
    expect(() => harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'window', pid: 1 }))
      .toThrow('窗口预览需要从 list_windows 获取有效的 pid 和 windowId')
  })

  test('Given 同一会话已有其他 owner 的运行中预览 When 再登记 Then 拒绝抢占', async () => {
    const harness = createHarness()
    showWindow(harness.service, 'owner-a')
    await harness.service.get(SESSION_ID, true)

    expect(() => showWindow(harness.service, 'owner-b')).toThrow('当前会话的上一次预览尚未结束')
  })

  test('Given 同一 owner 对同一窗口重复登记 When 对比 ID Then 复用同一预览并更新标题', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const first = await harness.service.get(SESSION_ID, true)

    harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'window', pid: 100, windowId: 200, label: '记事本（已编辑）' })
    const second = await harness.service.get(SESSION_ID, false)

    expect(second?.id).toBe(first?.id)
    expect(second?.label).toBe('记事本（已编辑）')
  })

  test('Given 同一 owner 切换窗口 When 再登记 Then 生成新预览并释放旧采集会话', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const first = await harness.service.get(SESSION_ID, true)

    showWindow(harness.service, OWNER, 101, 201)
    const second = await harness.service.get(SESSION_ID, true)

    expect(second?.id).not.toBe(first?.id)
    expect(harness.releases).toEqual([first?.id ?? ''])
    expect(harness.captures).toHaveLength(2)
  })

  test('Given 运行中预览 When finish Then 状态结束且 2 秒后自动清理', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    await harness.service.get(SESSION_ID, true)

    harness.service.finish(OWNER)
    const finished = await harness.service.get(SESSION_ID, false)
    expect(finished?.status).toBe('finished')
    expect(typeof finished?.finishedAt).toBe('number')

    await Bun.sleep(2_200)

    expect(await harness.service.get(SESSION_ID, false)).toBeNull()
  })

  test('Given 其他 owner 调用 finish When 检查 Then 不影响现有预览', async () => {
    const harness = createHarness()
    showWindow(harness.service, 'owner-a')

    harness.service.finish('owner-b')

    expect((await harness.service.get(SESSION_ID, false))?.status).toBe('running')
  })

  test('Given 正在采集 When 并发轮询 Then 同一帧只采集一次', async () => {
    const harness = createHarness()
    let releaseFirst: ((value: string) => void) | undefined
    harness.setCapture(() => new Promise<string>((resolve) => { releaseFirst = resolve }))
    showWindow(harness.service)

    const firstPoll = harness.service.get(SESSION_ID, true)
    const secondPoll = harness.service.get(SESSION_ID, true)
    await Bun.sleep(0)
    expect(harness.captures).toHaveLength(1)

    releaseFirst?.(PNG_DATA_URL)
    const [a, b] = await Promise.all([firstPoll, secondPoll])

    expect(a?.image).toBe(PNG_DATA_URL)
    expect(b?.image).toBe(PNG_DATA_URL)
  })

  test('Given 从未采集的预览 When 关闭 Then 只删除记录，不调用驱动释放', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const state = await harness.service.get(SESSION_ID, false)

    harness.service.dismiss(SESSION_ID, state?.id ?? '')

    expect(harness.releases).toHaveLength(0)
    expect(await harness.service.get(SESSION_ID, false)).toBeNull()
  })

  test('Given 已采集的预览 When 关闭 Then 释放驱动采集会话', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const state = await harness.service.get(SESSION_ID, true)

    harness.service.dismiss(SESSION_ID, state?.id ?? '')
    await Bun.sleep(0)

    expect(harness.releases).toEqual([state?.id ?? ''])
    expect(await harness.service.get(SESSION_ID, false)).toBeNull()
  })

  test('Given id 不匹配 When 关闭 Then 忽略请求', async () => {
    const harness = createHarness()
    showWindow(harness.service)

    harness.service.dismiss(SESSION_ID, 'not-the-current-id')

    expect((await harness.service.get(SESSION_ID, false))?.status).toBe('running')
  })
})

describe('预览失败与重试', () => {
  test('Given 采集抛普通错误 When 轮询 Then 进入 error 且归类为 capture_failed', async () => {
    const harness = createHarness()
    harness.setCapture(async () => { throw new Error('无效预览图片') })
    showWindow(harness.service)

    const state = await harness.service.get(SESSION_ID, true)

    expect(state?.status).toBe('error')
    expect(state?.errorCode).toBe('capture_failed')
    expect(state?.error).toContain('未能取得有效窗口画面')
  })

  test('Given 窗口已失效 When 采集 Then 保留原始错误分类', async () => {
    const harness = createHarness()
    harness.setCapture(async () => { throw new ComputerUseDriverError('window_unavailable') })
    showWindow(harness.service)

    const state = await harness.service.get(SESSION_ID, true)

    expect(state?.status).toBe('error')
    expect(state?.errorCode).toBe('window_unavailable')
    expect(state?.error).toContain('目标窗口已关闭')
  })

  test('Given 运行中预览 When 重试 Then 返回 null 且不重建', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const state = await harness.service.get(SESSION_ID, true)

    expect(await harness.service.retry(SESSION_ID, state?.id ?? '')).toBeNull()
  })

  test('Given 采集失败 When 重试 Then 重新采集并恢复 running', async () => {
    const harness = createHarness()
    harness.setCapture(async () => { throw new ComputerUseDriverError('capture_failed') })
    showWindow(harness.service)
    const failed = await harness.service.get(SESSION_ID, true)

    harness.setCapture(async () => PNG_DATA_URL)
    const recovered = await harness.service.retry(SESSION_ID, failed?.id ?? '')

    expect(recovered?.status).toBe('running')
    expect(recovered?.error).toBeUndefined()
    expect(recovered?.image).toBe(PNG_DATA_URL)
    expect(harness.captures).toHaveLength(2)
  })
})

describe('打开预览窗口', () => {
  test('Given 运行中的窗口预览 When activate Then 把该窗口切到前台', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const state = await harness.service.get(SESSION_ID, true)

    await harness.service.activate(SESSION_ID, state?.id ?? '')

    expect(harness.activations).toEqual([{ target: 'window', pid: 100, windowId: 200 }])
  })

  test('Given 桌面预览 When activate Then 拒绝并提示窗口已失效', async () => {
    const harness = createHarness()
    harness.service.show(OWNER, SESSION_ID, { action: 'show', target: 'desktop' })
    const state = await harness.service.get(SESSION_ID, true)

    await expect(harness.service.activate(SESSION_ID, state?.id ?? '')).rejects.toThrow('预览窗口已失效')
  })

  test('Given 已结束的预览 When activate Then 拒绝', async () => {
    const harness = createHarness()
    showWindow(harness.service)
    const state = await harness.service.get(SESSION_ID, true)
    harness.service.finish(OWNER)

    await expect(harness.service.activate(SESSION_ID, state?.id ?? '')).rejects.toThrow('预览窗口已失效')
  })
})
