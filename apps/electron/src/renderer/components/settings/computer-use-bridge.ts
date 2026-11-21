/**
 * Computer Use preload 契约适配层。
 *
 * 安装检测、更新检查与状态订阅都由主进程提供，renderer 只读取结构化结论。
 * 这里集中封装 IPC 调用与统一错误文案，设置页与侧栏红点都走同一入口。
 * `getComputerUseUpdateStatus` 只读主进程缓存，不触发网络请求。
 */

import type { ComputerUseInstallation, CuaUpdateStatus } from '@proma/shared'

/** 契约缺失时的统一错误文案。 */
const BRIDGE_UNAVAILABLE = 'Computer Use 接口尚未就绪，请重启 Proma 后重试。'

/** 旧版本 preload 可能还没有这些方法，运行时先确认可用。 */
function hasComputerUseApi(): boolean {
  return typeof window.electronAPI?.getComputerUseInstallationStatus === 'function'
}

/** 读取本机 Cua Driver 安装状态；接口缺失时拒绝，由调用方展示「检测失败」。 */
export function fetchComputerUseInstallation(): Promise<ComputerUseInstallation> {
  if (!hasComputerUseApi()) return Promise.reject(new Error(BRIDGE_UNAVAILABLE))
  return window.electronAPI.getComputerUseInstallationStatus()
}

/** 主动检查 CDN 上是否有新版本；主进程会合并并发请求。 */
export function requestComputerUseUpdateCheck(): Promise<CuaUpdateStatus> {
  if (!hasComputerUseApi()) return Promise.reject(new Error(BRIDGE_UNAVAILABLE))
  return window.electronAPI.checkComputerUseUpdateStatus()
}

/** 读取主进程缓存的更新状态；接口缺失时视为未知。 */
export async function readComputerUseUpdateStatus(): Promise<CuaUpdateStatus> {
  if (!hasComputerUseApi()) return { status: 'unknown' }
  return window.electronAPI.getComputerUseUpdateStatus()
}

/** 订阅更新状态推送；接口缺失时返回空清理函数。 */
export function subscribeComputerUseUpdateStatus(
  listener: (status: CuaUpdateStatus) => void,
): () => void {
  if (!hasComputerUseApi()) return () => {}
  return window.electronAPI.onComputerUseUpdateStatusChanged(listener)
}
