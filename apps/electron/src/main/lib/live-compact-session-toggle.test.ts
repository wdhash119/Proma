/**
 * P4：会话级 Live Compact 开关的 IPC / RPC 四层契约（源码级护栏）。
 *
 * 这些断言防的是“某一层漏改”：shared 常量、main handler、preload bridge、
 * renderer 调用、utility RPC 路由、以及全局主闸变化后的重推。
 * 行为正确性由 live-compact-toggle.test.ts 覆盖，这里只锁契约形状。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_IPC_CHANNELS, AGENT_RUNTIME_METHODS } from '@proma/shared'

/** apps/electron 根目录：本文件位于 apps/electron/src/main/lib。 */
const appRoot = join(import.meta.dir, '../../..')
const repoRoot = join(appRoot, '../..')

function readApp(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('Live Compact 会话开关 IPC 通道', () => {
  test('Given shared 通道常量 When 检查 Then 存在专用通道且命名对齐既有键', () => {
    expect(AGENT_IPC_CHANNELS.UPDATE_SESSION_LIVE_COMPACT).toBe('agent:update-session-live-compact')
    const shared = readRepo('packages/shared/src/types/agent.ts')
    expect(shared).toContain("UPDATE_SESSION_LIVE_COMPACT: 'agent:update-session-live-compact'")
  })

  test('Given main ipc When 检查 handler Then 校验布尔、断言主窗口并落到服务层', () => {
    const ipc = readApp('src/main/ipc.ts')
    const handlerStart = ipc.indexOf('AGENT_IPC_CHANNELS.UPDATE_SESSION_LIVE_COMPACT,')
    expect(handlerStart).toBeGreaterThan(-1)
    const handler = ipc.slice(handlerStart, handlerStart + 900)

    expect(handler).toContain('assertLiveCompactMainRenderer(event.sender.id)')
    expect(handler).toContain("typeof enabled !== 'boolean'")
    expect(handler).toContain('setAgentSessionLiveCompactEnabled(sessionId, enabled)')
  })

  test('Given preload When 检查 bridge Then 接口与实现都按 (sessionId, enabled) 调用通道', () => {
    const preload = readApp('src/preload/index.ts')
    expect(preload).toContain('updateSessionLiveCompact: (sessionId: string, enabled: boolean) => Promise<AgentSessionMeta>')
    expect(preload).toContain('ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_LIVE_COMPACT, sessionId, enabled)')
  })

  test('Given provider 接口 When 检查 Then 带可选的热切换方法', () => {
    const provider = readRepo('packages/shared/src/types/agent-provider.ts')
    expect(provider).toContain('setLiveCompactEnabled?(sessionId: string, enabled: boolean): Promise<void>')
  })
})

describe('Live Compact 中途生效链路', () => {
  test('Given 服务层 When 会话开关被点下 Then 先落 meta 再推生效态', () => {
    const service = readApp('src/main/lib/agent-service.ts')
    const start = service.indexOf('export async function setAgentSessionLiveCompactEnabled')
    expect(start).toBeGreaterThan(-1)
    const body = service.slice(start, start + 1200)

    expect(body).toContain('updateAgentSessionMeta(sessionId, { liveCompact: enabled })')
    // 推的是解析后的 effective，而不是原始 meta 值（全局主闸语义必须留在主进程单源）。
    expect(body).toContain('resolveLiveCompactEnabled(updated, getSettings())')
    expect(body).toContain('orchestrator.updateSessionLiveCompact(')
  })

  test('Given 全局主闸变化 When 设置写入 Then 对所有运行中会话重推生效态', () => {
    const service = readApp('src/main/lib/agent-service.ts')
    expect(service).toContain('export async function resyncLiveCompactForActiveSessions')
    expect(service).toContain('orchestrator.listActiveSessionSnapshots()')

    const ipc = readApp('src/main/ipc.ts')
    expect(ipc).toContain('if (updates.liveCompact !== undefined)')
    expect(ipc).toContain('void resyncLiveCompactForActiveSessions()')
  })

  test('Given 编排层 When 推送 Then 只对运行中会话下发并走 adapter 可选方法', () => {
    const orchestrator = readApp('src/main/lib/agent-orchestrator.ts')
    const start = orchestrator.indexOf('async updateSessionLiveCompact(')
    expect(start).toBeGreaterThan(-1)
    const body = orchestrator.slice(start, start + 600)
    expect(body).toContain('this.activeSessions.has(sessionId)')
    expect(body).toContain('this.adapter.setLiveCompactEnabled(sessionId, enabled)')
  })

  test('Given utility 进程 When 收到 RPC Then 路由到 setLiveCompactEnabled 且校验活跃查询', () => {
    const runtime = readApp('src/utility/agent-runtime.ts')
    expect(runtime).toContain('case AGENT_RUNTIME_METHODS.QUERY_SET_LIVE_COMPACT:')
    expect(runtime).toContain('void handleSetLiveCompact(request)')
    expect(runtime).toContain('piAdapter.setLiveCompactEnabled(activeQuery.sessionId, payload.enabled)')

    const adapter = readApp('src/main/lib/adapters/pi-utility-adapter.ts')
    expect(adapter).toContain('AGENT_RUNTIME_METHODS.QUERY_SET_LIVE_COMPACT')
  })

  test('Given RPC 常量 When 检查 Then 与权限模式同属 query 控制方法组', () => {
    expect(AGENT_RUNTIME_METHODS.QUERY_SET_LIVE_COMPACT).toBe('agent.query.setLiveCompactEnabled')
    const shared = readRepo('packages/shared/src/types/agent-runtime.ts')
    expect(shared).toContain("QUERY_SET_LIVE_COMPACT: 'agent.query.setLiveCompactEnabled'")
  })

  test('Given Pi adapter When 查询起点 When 检查 Then 用本次解析值刷新同一引用', () => {
    const adapter = readApp('src/main/lib/adapters/pi-agent-adapter.ts')
    expect(adapter).toContain('applyLiveCompactEnabled(active, input.liveCompact?.enabled === true)')
    // 工厂仍读共享引用的 enabled 字段（不是快照值）。
    expect(adapter).toContain('isEnabled: () => enabledRef.enabled')
  })
})
