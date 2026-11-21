/**
 * 清单快速捕获触发去重。
 *
 * 声明 `localFallback` 后，渲染进程 keydown 与主进程全局快捷键 IPC
 * 会在应用聚焦且全局注册成功时同时到达，直接各自递增会触发两次新建。
 * 这里用短时间窗去重：同一轮按键只执行一次打开动作。
 */

export interface QuickCaptureTriggerOptions {
  /** 仅供测试：注入时钟。 */
  now?: () => number
  /** 去重窗口；默认 300ms，覆盖 keydown 与 IPC 的到达间隔。 */
  windowMs?: number
}

export function createQuickCaptureTrigger(
  open: () => void,
  options: QuickCaptureTriggerOptions = {},
): () => boolean {
  const now = options.now ?? (() => Date.now())
  const windowMs = options.windowMs ?? 300
  let lastTriggeredAt = Number.NEGATIVE_INFINITY

  return () => {
    const current = now()
    if (current - lastTriggeredAt < windowMs) return false
    lastTriggeredAt = current
    open()
    return true
  }
}
