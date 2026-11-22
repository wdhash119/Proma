/**
 * useComputerUseUpdateStatus — 订阅 Cua Driver 更新状态
 *
 * 挂载时读取一次主进程缓存状态，并订阅后续推送；卸载时取消订阅。
 * 同时返回本地覆盖函数，供主动检查更新后立即刷新界面（不必等待推送）。
 * 用于设置侧栏更新红点与 Computer Use 页的更新条。
 */

import * as React from 'react'
import type { CuaUpdateStatus } from '@proma/shared'
import {
  readComputerUseUpdateStatus,
  subscribeComputerUseUpdateStatus,
} from '@/components/settings/computer-use-bridge'

const UNKNOWN_STATUS: CuaUpdateStatus = { status: 'unknown' }

interface ComputerUseUpdateStatusState {
  /** 当前更新状态 */
  status: CuaUpdateStatus
  /** 主动检查后写入本地状态 */
  applyStatus: (next: CuaUpdateStatus) => void
}

export function useComputerUseUpdateStatus(): ComputerUseUpdateStatusState {
  const [status, setStatus] = React.useState<CuaUpdateStatus>(UNKNOWN_STATUS)

  React.useEffect(() => {
    let active = true
    readComputerUseUpdateStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch(() => {
        // 读取失败保持 unknown，不阻塞设置页其他内容
      })

    const unsubscribe = subscribeComputerUseUpdateStatus((next) => {
      if (active) setStatus(next)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const applyStatus = React.useCallback((next: CuaUpdateStatus): void => setStatus(next), [])

  return { status, applyStatus }
}
