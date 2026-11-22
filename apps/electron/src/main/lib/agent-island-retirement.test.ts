import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')
const repoRoot = join(appRoot, '../..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('Agent 灵动岛退役', () => {
  test('Given 主进程 When 检查 Then 岛状态机与悬停窗服务已移除', () => {
    for (const removed of [
      'apps/electron/src/main/lib/agent-island-service.ts',
      'apps/electron/src/main/lib/agent-island-plan-quota.ts',
      'apps/electron/src/main/lib/agent-island-planning.ts',
      'apps/electron/src/main/lib/agent-island-priority.ts',
      'apps/electron/src/main/lib/agent-island-session-visibility.ts',
      'apps/electron/src/main/lib/agent-island-visibility.ts',
      'apps/electron/src/main/lib/mac-agent-island-native-host.ts',
      'apps/electron/src/main/lib/windows-agent-island-surface.ts',
      'apps/electron/src/main/lib/macos-version.ts',
      'apps/electron/src/main/agent-status-hover-window.ts',
      'apps/electron/src/main/agent-status-hover-bounds.ts',
      'apps/electron/src/renderer/components/agent-status-hover/HoverPanel.tsx',
      'packages/shared/src/types/agent-island.ts',
      'apps/electron/native/agent-island/macos-agent-island-helper.swift',
    ]) {
      expect(existsSync(join(repoRoot, removed))).toBe(false)
    }
  })

  test('Given 入口与 IPC When 检查 Then 不再引用岛状态与悬停窗通道', () => {
    const mainIndex = readRepoFile('apps/electron/src/main/index.ts')
    const mainIpc = readRepoFile('apps/electron/src/main/ipc.ts')
    const preload = readRepoFile('apps/electron/src/preload/index.ts')

    for (const source of [mainIndex, mainIpc, preload]) {
      expect(source).not.toContain('agent-island')
      expect(source).not.toContain('AGENT_ISLAND_IPC_CHANNELS')
      expect(source).not.toContain('WINDOWS_AGENT_ISLAND_IPC_CHANNELS')
    }
  })

  test('Given 托盘 When 检查 Then 托盘图标保留但不再有悬停面板与闪烁', () => {
    const tray = readRepoFile('apps/electron/src/main/tray.ts')

    expect(tray).toContain('export function createTray')
    expect(tray).toContain("label: '新建 Agent 会话'")
    expect(tray).not.toContain('onTrayMouseEnter')
    expect(tray).not.toContain('setTrayFlash')
  })

  test('Given 设置页 When 检查 Then 灵动岛开关已移除', () => {
    const settings = readRepoFile('apps/electron/src/renderer/components/settings/GeneralSettings.tsx')

    expect(settings).not.toContain('灵动岛')
    expect(settings).not.toContain('agentIsland')
  })

  test('Given 打包配置 When 检查 Then 不再携带原生岛宿主二进制', () => {
    const builder = readRepoFile('apps/electron/electron-builder.yml')

    expect(builder).not.toContain('agent-island/macos-agent-island-helper')
    expect(builder).toContain('eventkit/macos-eventkit.node')
  })

  test('Given 后台完成 When 检查 Then 提示音改由渲染进程的单一提醒入口统一门控', () => {
    const listeners = readRepoFile('apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts')

    // 声音不再绕过成功状态/策略单独播放，而是与桌面通知共用同一份决策。
    expect(listeners).toContain('decideCompletionNotification(')
    expect(listeners).toContain('playSound: notificationDecision.sound')
    expect(listeners).not.toContain('playNotificationSoundForType')
  })
})
