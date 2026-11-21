import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsDirectory = import.meta.dir
const repoRoot = join(settingsDirectory, '../../../../../../')

describe('Proma 默认系统提示词只读预览', () => {
  test('Given 人设 IPC 常量 When 检查 Then 新增默认系统提示词通道', () => {
    const source = readFileSync(join(repoRoot, 'packages/shared/src/types/persona.ts'), 'utf8')

    expect(source).toContain('GET_DEFAULT_SYSTEM_PROMPT')
    expect(source).toContain("'persona:get-default-system-prompt'")
  })

  test('Given 主进程 When 检查 handler Then 用中性上下文调用 buildSystemPrompt', () => {
    const source = readFileSync(join(settingsDirectory, '../../../main/ipc.ts'), 'utf8')

    expect(source).toContain('buildSystemPrompt')
    expect(source).toContain('PERSONA_IPC_CHANNELS.GET_DEFAULT_SYSTEM_PROMPT')
    expect(source).toContain("sessionId: 'persona-default-preview'")
    expect(source).toContain("permissionMode: 'plan'")
    expect(source).toContain('productivityTools: settings.productivityTools')
  })

  test('Given preload bridge When 检查 Then 暴露 getDefaultSystemPrompt 并转发同一通道', () => {
    const source = readFileSync(join(settingsDirectory, '../../../preload/index.ts'), 'utf8')

    expect(source).toContain('getDefaultSystemPrompt: () => Promise<string>')
    expect(source).toContain('ipcRenderer.invoke(PERSONA_IPC_CHANNELS.GET_DEFAULT_SYSTEM_PROMPT)')
  })

  test('Given 默认助手选中 When 检查设置页 Then 拉取预览并渲染只读区域', () => {
    const source = readFileSync(join(settingsDirectory, 'PersonaSettings.tsx'), 'utf8')

    expect(source).toContain('window.electronAPI.getDefaultSystemPrompt()')
    expect(source).toContain('Proma 默认系统提示词（只读预览）')
    expect(source).toContain('此人设不注入额外提示词；以上为 Agent 默认使用的产品系统提示词')
    expect(source).toContain('max-h-[320px]')
    expect(source).toContain('font-mono')
    // 失败时给出重试入口，而不是静默空白。
    expect(source).toContain('setDefaultPromptAttempt((attempt) => attempt + 1)')
  })
})
