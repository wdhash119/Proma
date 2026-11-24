import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('记忆工具契约', () => {
  test('Given Agent 运行时 When 检查 Then 注册了五个记忆工具', () => {
    const adapter = readAppFile('src/main/lib/adapters/pi-agent-adapter.ts')

    for (const toolName of ['MemorySearch', 'MemoryInspect', 'MemoryUpdate', 'MemoryHistory', 'MemoryAudit']) {
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

  test('Given MemorySearch 工具 When 检查描述 Then 与词法检索实现一致且不承诺语义联想', () => {
    const adapter = readAppFile('src/main/lib/adapters/pi-agent-adapter.ts')
    const block = adapter.slice(adapter.indexOf("name: 'MemorySearch'"))

    expect(block).toContain('2-gram')
    expect(block).toContain('完整 token')
    expect(block).toContain('覆盖率')
    expect(block).toContain('不做同义词与语义联想')
    // 旧描述把检索说成「关键词按子串匹配」，与 2-gram/子段分词不一致。
    expect(block).not.toContain('多个词用空格分隔，按子串匹配')
  })

  test('Given MemoryUpdate 工具 When 检查描述 Then 明确单条预算与重复写入契约', () => {
    const adapter = readAppFile('src/main/lib/adapters/pi-agent-adapter.ts')
    const start = adapter.indexOf("name: 'MemoryUpdate'")
    const block = adapter.slice(start, adapter.indexOf("name: 'MemoryHistory'", start))

    expect(block).toContain('1000 UTF-16 码元')
    expect(block).toContain('重复 add 幂等跳过')
    expect(block).toContain('完全重复条目')
    expect(block).toContain('user-profile.md 与 user_profile.md 仅供迁移读取')
    expect(block).toContain('update 省略 source/occurredAt 时保留原值')
    expect(block).toContain('正文与元数据均无变化时幂等')
    expect(block).toContain('source: Type.Optional')
    expect(block).toContain('occurredAt: Type.Optional')
    expect(block).toContain('不代表服务已验证内容')
    expect(block).toContain('记录时间由服务在实际写入时自动生成')
    expect(block).toContain('content 与 operations 只能二选一')
    expect(block).toContain('content')
  })

  test('Given MemoryAudit 工具 When 检查描述 Then 声明只读启发式候选而非语义结论', () => {
    const adapter = readAppFile('src/main/lib/adapters/pi-agent-adapter.ts')
    const start = adapter.indexOf("name: 'MemoryAudit'")
    expect(start).toBeGreaterThan(-1)
    const block = adapter.slice(start, adapter.indexOf("name: 'Present'", start))

    expect(block).toContain('只读')
    expect(block).toContain('启发式')
    expect(block).toContain('不是语义结论')
    expect(block).toContain('不自动合并')
    expect(block).toContain('exact-duplicate')
    expect(block).toContain('dangling-route')
    // 只读工具不应接受任何写入参数。
    expect(block).not.toContain('content')
    expect(block).not.toContain('revision')
  })

  test('Given knowledge-maintenance When 检查 Then 要求按需审计并保留人工确认', () => {
    const skill = readAppFile('default-skills/knowledge-maintenance/SKILL.md')

    expect(skill).toContain('MemoryAudit')
    expect(skill).toContain('候选不是语义结论')
    expect(skill).toContain('仍需确认')
    expect(skill).toContain('version: "1.0.6"')
  })

  test('Given 系统提示词 When 检查 Then 记忆工具说明覆盖 MemoryAudit', () => {
    const prompt = readAppFile('src/main/lib/agent-prompt-builder.ts')

    expect(prompt).toContain('MemoryAudit')
    expect(prompt).toContain('只读审计')
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
