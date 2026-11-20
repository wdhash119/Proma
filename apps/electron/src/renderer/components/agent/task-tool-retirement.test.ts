import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererAgentDirectory = join(import.meta.dir)
const repoRoot = join(import.meta.dir, '../../../../../..')

function readAgentFile(name: string): string {
  return readFileSync(join(rendererAgentDirectory, name), 'utf8')
}

describe('任务工具族下线', () => {
  test('Given Pi 工具定义 When 检查 Then 只保留询问用户，任务工具不再注入', () => {
    const source = readFileSync(join(repoRoot, 'apps/electron/src/main/lib/adapters/pi-agent-adapter.ts'), 'utf8')

    expect(source).toContain("name: 'AskUserQuestion'")
    for (const toolName of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoRead']) {
      expect(source).not.toContain(`name: '${toolName}'`)
    }
  })

  test('Given 系统提示词 When 检查 Then 不再要求调用任务工具维护进度', () => {
    const source = readFileSync(join(repoRoot, 'apps/electron/src/main/lib/agent-prompt-builder.ts'), 'utf8')

    expect(source).not.toContain('TaskCreate')
    expect(source).not.toContain('TaskUpdate')
    // 改为文字说明进展，仍需约束过程说明的长度。
    expect(source).toContain('用一段简短文字说明计划和当前阶段')
  })

  test('Given 渲染层 When 检查 Then 任务进度浮层与专属渲染已移除', () => {
    for (const removed of ['TaskProgressOverlay.tsx', 'TaskProgressCard.tsx', 'task-progress.ts']) {
      expect(existsSync(join(rendererAgentDirectory, removed))).toBe(false)
    }
    expect(existsSync(join(rendererAgentDirectory, 'tool-result-renderers/task-get-result.tsx'))).toBe(false)
    expect(existsSync(join(rendererAgentDirectory, 'tool-result-renderers/task-list-result.tsx'))).toBe(false)
  })

  test('Given 历史会话 When 检查 Then 任务调用按普通工具行渲染', () => {
    const renderer = readAgentFile('SDKMessageRenderer.tsx')
    expect(renderer).not.toContain('TASK_TOOL_NAMES')
    expect(renderer).not.toContain('buildTaskProgressData')

    // 工具信息与短语不再为任务工具做专属分支，落到通用工具行。
    for (const file of ['tool-utils.ts', 'tool-phrase.ts']) {
      const source = readAgentFile(file)
      expect(source).not.toContain("case 'TaskCreate'")
      expect(source).not.toContain("case 'TaskUpdate'")
      expect(source).not.toContain("case 'TaskGet'")
      expect(source).not.toContain("case 'TaskList'")
    }
  })
})

describe('上下文压缩反馈进入消息流', () => {
  test('Given Agent 消息区 When 检查 Then 显示对话内单行提示而非浮层', () => {
    const source = readAgentFile('AgentMessages.tsx')

    expect(source).toContain('<CompactionNotice progress={contextCompaction} />')
    expect(source).not.toContain('TaskProgressOverlay')
  })

  test('Given 压缩提示组件 When 检查 Then 字号与正文一致且单行截断', () => {
    const source = readAgentFile('CompactionNotice.tsx')

    expect(source).toContain('--md-preview-font-size')
    expect(source).toContain('truncate')
    expect(source).toContain('COMPACTION_NOTICE_RETENTION_MS')
  })
})
