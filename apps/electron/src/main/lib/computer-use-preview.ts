/**
 * Computer Use 窗口镜像预览服务。
 *
 * Agent 通过 ComputerUsePreview 工具登记「当前要操作的窗口/桌面」，主进程据此
 * 定期抓取画面并交给 renderer 展示成镜像面板。这里只维护状态机和采集编排：
 * 平台采集、驱动调用与窗口激活全部通过依赖注入，便于单元测试覆盖边界而无需
 * 真实 Electron 或 Cua Driver。
 *
 * 状态机：show → running（可重复 show 更新 label / 目标）→ finish → finished
 * （2 秒后自动清理）；采集失败进入 error，可通过 retry 重新采集。
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUsePreviewState, ComputerUsePreviewTarget } from '@proma/shared'
import { ComputerUseDriverError, callComputerUseDriver } from './computer-use-driver'

/** finish 之后保留终态供 renderer 收尾的时长。 */
const FINISHED_RETENTION_MS = 2_000
/** 预览图片上限；超过即视为异常采集结果。 */
const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024
/** PNG 文件头（89 50 4E 47 0D 0A 1A 0A）。 */
const PNG_MAGIC_HEX = '89504e470d0a1a0a'
/** 预览截图最长边；过大的图片会显著拖慢 renderer 解码与轮询。 */
const PREVIEW_MAX_IMAGE_DIMENSION = 960

/** Agent 调用 ComputerUsePreview 的入参。 */
export interface ComputerUsePreviewShowInput {
  action: 'show' | 'finish'
  target?: ComputerUsePreviewTarget
  label?: string
  pid?: number
  windowId?: number
}

/** 经过校验后的预览目标（window 一定带有效 pid / windowId）。 */
export interface ComputerUsePreviewWindowTarget {
  target: 'window'
  pid: number
  windowId: number
}

/** 采集回调的入参。 */
export interface ComputerUsePreviewCaptureInput {
  /** 本次预览 ID，用于生成驱动会话名。 */
  id: string
  target: ComputerUsePreviewTarget
  pid?: number
  windowId?: number
  signal: AbortSignal
}

/** 预览服务的全部外部依赖。 */
interface ComputerUsePreviewDependencies {
  /** 采集一帧画面，返回 data URL。失败时抛错，服务统一归类为 capture_failed。 */
  capture: (input: ComputerUsePreviewCaptureInput) => Promise<string>
  /** 释放驱动侧采集会话。 */
  release: (previewId: string) => Promise<void>
  /** 把目标窗口切到前台。 */
  activate: (target: ComputerUsePreviewWindowTarget) => Promise<void>
}

interface PreviewEntry {
  /** 拥有本次预览的工具调用方，用于阻止两个调用方争抢同一会话的预览。 */
  owner: string
  target: ComputerUsePreviewTarget
  pid?: number
  windowId?: number
  controller: AbortController
  state: ComputerUsePreviewState
  /** 正在进行的采集；同一帧不会被并发重复采集。 */
  pending?: Promise<void>
  /** 是否真正发起过采集，决定是否需要释放驱动会话。 */
  captureStarted: boolean
  released: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export class ComputerUsePreviewService {
  private readonly entries = new Map<string, PreviewEntry>()

  constructor(private readonly dependencies: ComputerUsePreviewDependencies) {}

  /**
   * 登记或结束预览。
   *
   * 同一个 owner 对同一目标重复 show 只更新 label，不会重建采集会话；
   * 目标变化时释放旧会话并新建，避免把旧窗口画面挂在错误的窗口名下。
   */
  show(owner: string, sessionId: string, input: ComputerUsePreviewShowInput): void {
    if (input.action === 'finish') {
      this.finish(owner)
      return
    }
    if (input.target !== 'window' && input.target !== 'desktop') {
      throw new Error('请选择窗口或桌面')
    }
    if (input.target === 'window' && (!isPositiveInteger(input.pid) || !isPositiveInteger(input.windowId))) {
      throw new Error('窗口预览需要从 list_windows 获取有效的 pid 和 windowId')
    }

    const current = this.entries.get(sessionId)
    if (current?.state.status === 'running' && current.owner !== owner) {
      throw new Error('当前会话的上一次预览尚未结束')
    }

    const label = input.label?.trim().slice(0, 100) || (input.target === 'desktop' ? '桌面' : '应用窗口')
    const sameTarget = input.target === 'desktop'
      ? current?.target === 'desktop'
      : current?.pid === input.pid && current?.windowId === input.windowId
    if (current?.state.status === 'running' && current.owner === owner && current.target === input.target && sameTarget) {
      current.state.label = label
      return
    }

    if (current) this.release(current)
    this.entries.set(sessionId, {
      owner,
      target: input.target,
      ...(input.target === 'window' ? { pid: input.pid, windowId: input.windowId } : {}),
      controller: new AbortController(),
      state: {
        id: randomUUID(),
        sessionId,
        target: input.target,
        label,
        transport: 'snapshot',
        status: 'running',
      },
      captureStarted: false,
      released: false,
    })
  }

  /** 结束 owner 当前的预览：停止采集并保留 2 秒终态。 */
  finish(owner: string): void {
    const entry = [...this.entries.values()].find((candidate) => candidate.owner === owner)
    if (!entry || entry.state.status === 'finished') return

    entry.state.finishedAt = Date.now()
    entry.state.status = 'finished'
    this.release(entry)
    entry.cleanupTimer = setTimeout(
      () => this.dismiss(entry.state.sessionId, entry.state.id),
      FINISHED_RETENTION_MS,
    )
    // 定时器不应阻止进程退出；不同运行时的 setTimeout 返回类型不同，这里只按可选能力调用。
    const timer = entry.cleanupTimer as { unref?: () => void }
    timer.unref?.()
  }

  /** 会话结束时兜底回收，避免遗留采集会话。 */
  finishSession(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry) this.finish(entry.owner)
  }

  /** 关闭预览并立即释放资源。renderer 关闭面板与定时清理都走这里。 */
  dismiss(sessionId: string, id: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.id !== id) return
    this.release(entry)
    this.entries.delete(sessionId)
  }

  /** 把预览目标窗口切到前台；预览已结束或目标为桌面时拒绝。 */
  async activate(sessionId: string, id: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (
      !entry
      || entry.state.sessionId !== sessionId
      || entry.state.id !== id
      || entry.state.status === 'finished'
      || entry.target !== 'window'
      || !entry.pid
      || !entry.windowId
    ) {
      throw new Error('预览窗口已失效')
    }
    await this.dependencies.activate({ target: 'window', pid: entry.pid, windowId: entry.windowId })
  }

  /** 采集失败后重新登记同一目标并立即采集一次。 */
  async retry(sessionId: string, id: string): Promise<ComputerUsePreviewState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.id !== id || entry.state.status !== 'error') return null
    this.show(entry.owner, sessionId, {
      action: 'show',
      target: entry.target,
      label: entry.state.label,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(entry.windowId !== undefined ? { windowId: entry.windowId } : {}),
    })
    return this.get(sessionId, true)
  }

  /**
   * 读取当前状态，可选触发一次采集。
   *
   * renderer 的 2 秒轮询每次都带 capture=true；采集进行中重复调用会复用同一
   * Promise，避免窗口卡顿时堆积请求。返回的是状态副本，调用方不能修改内部记录。
   */
  async get(sessionId: string, capture: boolean): Promise<ComputerUsePreviewState | null> {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.sessionId !== sessionId) return null

    if (entry.state.finishedAt && Date.now() - entry.state.finishedAt > FINISHED_RETENTION_MS) {
      this.dismiss(sessionId, entry.state.id)
      return null
    }

    if (capture && entry.state.status === 'running') {
      entry.captureStarted = true
      entry.pending ??= this.dependencies.capture({
        id: entry.state.id,
        target: entry.target,
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        ...(entry.windowId !== undefined ? { windowId: entry.windowId } : {}),
        signal: entry.controller.signal,
      }).then((image) => {
        if (entry.controller.signal.aborted) return
        entry.state.image = image
        entry.state.capturedAt = Date.now()
      }).catch((error: unknown) => {
        if (entry.controller.signal.aborted) return
        const failure = error instanceof ComputerUseDriverError ? error : new ComputerUseDriverError('capture_failed')
        entry.state.status = 'error'
        entry.state.error = failure.message
        entry.state.errorCode = failure.code
        this.release(entry)
      }).finally(() => {
        entry.pending = undefined
      })
      await entry.pending
    }

    return this.entries.get(sessionId) === entry ? { ...entry.state } : null
  }

  /** 中止采集并释放驱动会话；重复调用安全。 */
  private release(entry: PreviewEntry): void {
    clearTimeout(entry.cleanupTimer)
    if (entry.released) return
    entry.released = true
    entry.controller.abort()
    if (!entry.captureStarted) return
    // 等采集 Promise 落定再结束会话，避免驱动仍在写文件时被拆除。
    void Promise.resolve(entry.pending)
      .finally(() => this.dependencies.release(entry.state.id))
      .catch(() => {})
  }
}

/** 驱动会文件名使用预览 ID；release 与 capture 必须用同一个会话名。 */
function previewDriverSession(id: string): string {
  return `proma-preview-${id}`
}

/** 采集当前目标的一帧 PNG，并转换成 renderer 可直接渲染的 data URL。 */
async function capturePreviewFrame(input: ComputerUsePreviewCaptureInput): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'proma-preview-'))
  try {
    const framePath = join(dir, 'frame.png')
    const common = {
      session: previewDriverSession(input.id),
      screenshot_out_file: framePath,
      max_image_dimension: PREVIEW_MAX_IMAGE_DIMENSION,
    }
    await callComputerUseDriver(
      input.target === 'desktop' ? 'get_desktop_state' : 'get_window_state',
      input.target === 'desktop'
        ? common
        : {
            ...common,
            pid: input.pid,
            window_id: input.windowId,
            include_accessibility_tree: false,
            display_only: true,
          },
      input.signal,
    )
    const image = await readFile(framePath)
    if (image.length > MAX_PREVIEW_IMAGE_BYTES || image.subarray(0, 8).toString('hex') !== PNG_MAGIC_HEX) {
      throw new Error('无效预览图片')
    }
    return `data:image/png;base64,${image.toString('base64')}`
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 结束驱动侧采集会话；失败不影响主流程（会话可能已因驱动退出而消失）。 */
async function releasePreviewSession(previewId: string): Promise<void> {
  await callComputerUseDriver('end_session', { session: previewDriverSession(previewId) })
}

/** 通过一次性的 bring_to_front 调用把目标窗口切到前台。 */
async function activatePreviewTarget(target: ComputerUsePreviewWindowTarget): Promise<void> {
  const session = `proma-preview-open-${randomUUID()}`
  try {
    await callComputerUseDriver('bring_to_front', {
      pid: target.pid,
      window_id: target.windowId,
      session,
    })
  } finally {
    await callComputerUseDriver('end_session', { session }).catch(() => {})
  }
}

/** 生产环境使用的依赖集合。 */
const defaultDependencies: ComputerUsePreviewDependencies = {
  capture: capturePreviewFrame,
  release: releasePreviewSession,
  activate: activatePreviewTarget,
}

/** 全局预览服务；工具、IPC 与安装状态检查共享同一实例。 */
export const computerUsePreview = new ComputerUsePreviewService(defaultDependencies)
