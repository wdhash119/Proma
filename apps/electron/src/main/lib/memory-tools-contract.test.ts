import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('记忆工具契约', () => {
  test('Given Agent 运行时 When 检查 Then 注册了四个记忆工具', () => {
    const adapter = readAppFile('src/main/lib/adapters/pi-agent-adapter.ts')

    for (const toolName of ['MemorySearch', 'MemoryInspect', 'MemoryUpdate', 'MemoryHistory']) {
      expect(adapter).toContain(`name: '${toolName}'`)
    }
    // 记忆工具需要工作区上下文才能定位项目记忆。
    expect(adapter).toContain('buildPromaProductToolDefinitions(sdk, input.canUseTool, input.skillWorkspaceSlug, input.sessionId)')
  })

  test('Given 系统提示词 When 检查 Then 要求走 MemoryUpdate 而不是直接覆盖记忆文件', () => {
    const prompt = readAppFile('src/main/lib/agent-prompt-builder.ts')

    expect(prompt).toContain('MemoryUpdate')
    expect(prompt).toContain('不要用 Edit/Write 直接覆盖记忆文件')
  })

  test('Given preload When 检查 Then 暴露读取、检索、历史与恢复通道', () => {
    const preload = readAppFile('src/preload/index.ts')

    for (const api of [
      'listMemoryTargets',
      'readMemoryTarget',
      'searchMemory',
      'listMemoryHistory',
      'restoreMemoryRevision',
    ]) {
      expect(preload).toContain(api)
    }
    // 读取历史版本正文没有渲染层调用方，IPC 入口已退役；主进程函数保留供安全回归测试使用。
    expect(preload).not.toContain('readMemoryRevision')
    expect(preload).toContain('MEMORY_IPC_CHANNELS')
  })

  test('Given 主进程 When 检查 Then 记忆写入只由 Agent 工具完成，渲染进程仅恢复', () => {
    const ipc = readAppFile('src/main/ipc.ts')

    expect(ipc).toContain('MEMORY_IPC_CHANNELS.RESTORE_REVISION')
    // 渲染进程没有直接改单条事实的通道，避免出现两套写入路径。
    expect(ipc).not.toContain('MEMORY_IPC_CHANNELS.UPDATE')
  })
})

describe('关于你设置页', () => {
  test('Given 设置导航 When 检查 Then 注册了关于你页', () => {
    const panel = readAppFile('src/renderer/components/settings/SettingsPanel.tsx')

    expect(panel).toContain('id: "about-you"')
    expect(panel).toContain('AboutYouSettings')
  })

  test('Given 关于你页 When 检查 Then 提供检索、历史与恢复', () => {
    const page = readAppFile('src/renderer/components/settings/AboutYouSettings.tsx')

    expect(page).toContain('searchMemory')
    expect(page).toContain('listMemoryHistory')
    expect(page).toContain('restoreMemoryRevision')
  })
})
