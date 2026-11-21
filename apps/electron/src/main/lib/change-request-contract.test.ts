import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('变更请求追踪契约', () => {
  test('Given 主进程 When 检查 Then 注册了 action 通道并接入流观察', () => {
    const ipc = readAppFile('src/main/ipc.ts')
    const service = readAppFile('src/main/lib/agent-service.ts')

    expect(ipc).toContain('CHANGE_REQUESTS_IPC_CHANNELS.ACTION')
    expect(ipc).toContain('handleChangeRequestsAction')
    expect(service).toContain('observeAgentStreamPayload')
  })

  test('Given 应用生命周期 When 检查 Then 启动与退出都处理轮询', () => {
    const index = readAppFile('src/main/index.ts')

    expect(index).toContain('initChangeRequestService')
    expect(index).toContain('disposeChangeRequestService')
  })

  test('Given preload When 检查 Then 暴露操作与推送订阅', () => {
    const preload = readAppFile('src/preload/index.ts')

    expect(preload).toContain('changeRequestsAction')
    expect(preload).toContain('onChangeRequestsChanged')
  })

  test('Given 改动区 When 检查 Then 顶部显示变更请求状态条', () => {
    const list = readAppFile('src/renderer/components/diff/DiffChangesList.tsx')

    expect(list).toContain('ChangeRequestBar')
  })

  test('Given 旧版单条 pullRequest When 检查 Then 读取时迁移到 changeRequests', () => {
    const store = readAppFile('src/main/lib/change-request-store.ts')

    expect(store).toContain('legacyPullRequestBinding')
    expect(store).toContain('migrateLegacyBindings')
  })

  test('Given PR 状态轮询 When 检查 Then 会话新鲜度不被后台元数据刷新', () => {
    const manager = readAppFile('src/main/lib/agent-session-manager.ts')

    expect(manager).toContain('isBackgroundMetadataOnly')
    expect(manager).toContain("key === 'changeRequests'")
  })
})

describe('会话检出契约', () => {
  test('Given worktree 选择 When 检查 Then 同时写入 checkoutHistory 与 baseCommit', () => {
    const ipc = readAppFile('src/main/ipc.ts')
    const piTools = readAppFile('src/main/lib/adapters/pi-builtin-tools.ts')

    for (const source of [ipc, piTools]) {
      expect(source).toContain('checkoutHistory')
      expect(source).toContain('readWorktreeHeadCommit')
    }
  })

  test('Given cwd 解析 When 检查 Then 走检出日志回退', () => {
    const manager = readAppFile('src/main/lib/agent-session-manager.ts')

    expect(manager).toContain('resolveSessionCheckout')
    expect(manager).toContain('checkoutFromActiveWorktree')
  })
})
