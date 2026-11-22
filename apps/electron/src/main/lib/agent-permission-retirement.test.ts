import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePlanningDeletionPermission } from './planning-permission-policy'

const mainLib = import.meta.dir
const adaptersDirectory = join(mainLib, 'adapters')
const preloadPath = join(mainLib, '../../preload/index.ts')
const ipcPath = join(mainLib, '../ipc.ts')

describe('权限模式退役后的工具契约', () => {
  test('Given Pi 产品工具定义 When 检查 Then 不再注册 EnterPlanMode / ExitPlanMode', () => {
    const source = readFileSync(join(adaptersDirectory, 'pi-agent-adapter.ts'), 'utf8')

    expect(source).not.toContain("name: 'EnterPlanMode'")
    expect(source).not.toContain("name: 'ExitPlanMode'")
  })

  test('Given 问答能力仍然保留 When 检查 Then AskUserQuestion 工具仍注册', () => {
    const source = readFileSync(join(adaptersDirectory, 'pi-agent-adapter.ts'), 'utf8')

    expect(source).toContain("name: 'AskUserQuestion'")
  })

  test('Given 编排层 When 检查 Then 不再保留计划模式工具白名单与只读判定', () => {
    const source = readFileSync(join(mainLib, 'agent-orchestrator.ts'), 'utf8')

    expect(source).not.toContain('PLAN_MODE_ALLOWED_TOOLS')
    expect(source).not.toContain('PLAN_MODE_READ_ONLY_PLANNING_TOOLS')
    expect(source).not.toContain('isBashCommandReadOnly')
  })
})

describe('权限交互 IPC 退役', () => {
  test('Given preload 桥接层 When 检查 Then 四个权限交互方法已移除', () => {
    const preload = readFileSync(preloadPath, 'utf8')

    for (const bridge of [
      'respondPermission',
      'updateSessionPermissionMode',
      'respondExitPlanMode',
      'getPendingRequests',
    ]) {
      expect(preload).not.toContain(`${bridge}:`)
    }
  })

  test('Given 主进程 IPC When 检查 Then 权限交互 handler 与通道常量已移除', () => {
    const ipc = readFileSync(ipcPath, 'utf8')

    expect(ipc).not.toContain('AGENT_IPC_CHANNELS.PERMISSION_RESPOND')
    expect(ipc).not.toContain('AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE')
    expect(ipc).not.toContain('AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND')
    expect(ipc).not.toContain('AGENT_IPC_CHANNELS.GET_PENDING_REQUESTS')
  })

  test('Given AskUser 问答链仍在使用 When 检查 Then 应答 bridge 保留', () => {
    const preload = readFileSync(preloadPath, 'utf8')

    expect(preload).toContain('respondAskUser:')
  })
})

describe('规划数据删除护栏', () => {
  test('Given 用户主会话 When 删除 Todo Then 直接放行', () => {
    expect(resolvePlanningDeletionPermission('mcp__planning__delete_todo', 'bypassPermissions', 'user')).toBe('allow')
  })

  test.each(['automation', 'delegation'] as const)(
    'Given 无人值守来源 %s When 删除规划数据 Then 拒绝',
    (triggeredBy) => {
      expect(resolvePlanningDeletionPermission('mcp__planning__delete_todo', 'bypassPermissions', triggeredBy)).toBe('deny-unattended')
      expect(resolvePlanningDeletionPermission('mcp__planning__delete_group', 'bypassPermissions', triggeredBy)).toBe('deny-unattended')
    },
  )

  test('Given 非规划删除工具 When 判定 Then 不介入', () => {
    expect(resolvePlanningDeletionPermission('Write', 'bypassPermissions', 'user')).toBe('not-planning-deletion')
  })
})
