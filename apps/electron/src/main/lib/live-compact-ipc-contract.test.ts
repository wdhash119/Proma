import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIVE_COMPACT_IPC_CHANNELS } from '@proma/shared'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

// 静态契约检查：四个通道必须同时出现在共享常量、主进程 handler、preload bridge 与
// 设置页调用点。任一环缺失都会让设置页按钮静默失效，因此用 source-text 断言兜住。
describe('Live Compact IPC 四层契约', () => {
  test('Given 共享契约 When 读取常量组 Then 四个通道键与值齐备', () => {
    expect(Object.keys(LIVE_COMPACT_IPC_CHANNELS)).toEqual([
      'GET_STATE',
      'CHECK_UPSTREAM',
      'SYNC',
      'RESET',
    ])
    expect(LIVE_COMPACT_IPC_CHANNELS.GET_STATE).toBe('live-compact:get-state')
    expect(LIVE_COMPACT_IPC_CHANNELS.CHECK_UPSTREAM).toBe('live-compact:check-upstream')
    expect(LIVE_COMPACT_IPC_CHANNELS.SYNC).toBe('live-compact:sync')
    expect(LIVE_COMPACT_IPC_CHANNELS.RESET).toBe('live-compact:reset')
  })

  test('Given 主进程 When 检查 Then 注册四个 handler 并持有同步服务单例', () => {
    const ipc = readAppFile('src/main/ipc.ts')

    expect(ipc).toContain('LIVE_COMPACT_IPC_CHANNELS.GET_STATE')
    expect(ipc).toContain('LIVE_COMPACT_IPC_CHANNELS.CHECK_UPSTREAM')
    expect(ipc).toContain('LIVE_COMPACT_IPC_CHANNELS.SYNC')
    expect(ipc).toContain('LIVE_COMPACT_IPC_CHANNELS.RESET')
    expect(ipc).toContain('createLiveCompactSyncService({ configDir: getConfigDir() })')
    expect(ipc).toContain('getLiveCompactSyncService().getState()')
    expect(ipc).toContain('getLiveCompactSyncService().checkUpstream()')
    expect(ipc).toContain('getLiveCompactSyncService().syncUpstream()')
    expect(ipc).toContain('getLiveCompactSyncService().resetToBundled()')
  })

  test('Given 同步失败 When 主进程处理 Then 把服务返回值原样交给 renderer 而不抛异常', () => {
    const ipc = readAppFile('src/main/ipc.ts')
    const syncHandler = ipc.slice(
      ipc.indexOf('LIVE_COMPACT_IPC_CHANNELS.SYNC,'),
      ipc.indexOf('LIVE_COMPACT_IPC_CHANNELS.RESET,'),
    )

    expect(syncHandler).toContain('return getLiveCompactSyncService().syncUpstream()')
    expect(syncHandler).not.toContain('throw new Error')
  })

  test('Given preload When 检查 Then 接口与实现各暴露四个 bridge', () => {
    const preload = readAppFile('src/preload/index.ts')

    for (const method of [
      'getLiveCompactState',
      'checkLiveCompactUpstream',
      'syncLiveCompactUpstream',
      'resetLiveCompactToBundled',
    ]) {
      // 接口声明与实现各出现一次。
      expect(preload.split(`${method}:`).length - 1).toBe(2)
    }
    expect(preload).toContain('ipcRenderer.invoke(LIVE_COMPACT_IPC_CHANNELS.GET_STATE)')
    expect(preload).toContain('ipcRenderer.invoke(LIVE_COMPACT_IPC_CHANNELS.CHECK_UPSTREAM)')
    expect(preload).toContain('ipcRenderer.invoke(LIVE_COMPACT_IPC_CHANNELS.SYNC)')
    expect(preload).toContain('ipcRenderer.invoke(LIVE_COMPACT_IPC_CHANNELS.RESET)')
  })

  test('Given 设置页 When 检查 Then 四个 bridge 都被调用', () => {
    const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')

    expect(settings).toContain('window.electronAPI.getLiveCompactState()')
    expect(settings).toContain('window.electronAPI.checkLiveCompactUpstream()')
    expect(settings).toContain('window.electronAPI.syncLiveCompactUpstream()')
    expect(settings).toContain('window.electronAPI.resetLiveCompactToBundled()')
  })
})
