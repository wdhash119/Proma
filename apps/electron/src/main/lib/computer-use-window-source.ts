/**
 * desktopCapturer 窗口源查找。
 *
 * 主进程用窗口源确认某个原生窗口仍存在，作为后续原生实时流的可用性校验。
 * Electron 只能在应用运行时导入，因此这里动态引入，保持模块可被非 Electron
 * 环境（如单元测试）安全加载。
 */

import type { DesktopCapturerSource } from 'electron'

/** 列举当前所有窗口源；不取缩略图与图标，避免无谓的位图复制。 */
export async function getComputerUseWindowSources(): Promise<DesktopCapturerSource[]> {
  const { desktopCapturer } = await import('electron')
  return desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
}

/**
 * 在窗口源列表中按 windowId 查找。
 *
 * Electron 的窗口源 ID 形如 `window:<id>:<0|1>`；只接受这种结构，避免把
 * 屏幕源或异常格式的 ID 误判成目标窗口。
 */
export function findComputerUseWindowSource(
  sources: DesktopCapturerSource[],
  windowId: number,
): DesktopCapturerSource | undefined {
  return sources.find((source) => /^window:\d+:[01]$/.test(source.id) && Number(source.id.split(':')[1]) === windowId)
}

/** 目标窗口当前是否仍可被桌面采集到。 */
export async function hasComputerUseWindowSource(windowId: number): Promise<boolean> {
  return !!findComputerUseWindowSource(await getComputerUseWindowSources(), windowId)
}
