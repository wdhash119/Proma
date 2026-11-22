import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const appRoot = join(rendererRoot, '../..')

describe('渲染层孤儿组件与死 barrel 退役', () => {
  test('Given 渲染层 When 检查 Then 无引用的组件与 barrel 文件已删除', () => {
    for (const removed of [
      'src/renderer/components/agent/WorkspaceSelector.tsx',
      'src/renderer/components/ui/command.tsx',
      'src/renderer/components/ui/sheet.tsx',
      'src/renderer/lib/tab-switcher-model.ts',
      'src/renderer/components/agent-skills/WorkspaceMemoryChangeDock.tsx',
      'src/renderer/components/app-shell/PanelHeader.tsx',
      'src/renderer/atoms/index.ts',
      'src/renderer/components/settings/index.ts',
      'src/renderer/components/tabs/index.ts',
    ]) {
      expect(existsSync(join(appRoot, removed))).toBe(false)
    }
  })

  test('Given 主进程 When 检查 Then 无引用的工具文件已删除', () => {
    for (const removed of [
      'src/main/lib/computer-use-window-source.ts',
      'src/main/lib/agent-plan-file-policy.ts',
    ]) {
      expect(existsSync(join(appRoot, removed))).toBe(false)
    }
  })

  test('Given Agent barrel When 检查 Then 只再导出 AgentView', () => {
    const barrel = readFileSync(join(rendererRoot, 'components/agent/index.ts'), 'utf8')

    expect(barrel).toContain("export { AgentView } from './AgentView'")
    expect(barrel).not.toContain('WorkspaceSelector')
    expect(barrel).not.toContain('export *')
  })
})

describe('Agent 消息渲染与快捷键初始化收敛', () => {
  test('Given 消息渲染器 When 检查 Then 单条消息组件退役而 Turn 渲染链路保留', () => {
    const source = readFileSync(join(rendererRoot, 'components/agent/SDKMessageRenderer.tsx'), 'utf8')

    // 标识符动态拼接，避免本测试文件自身命中。
    expect(source).not.toContain(['function SDKMessage', 'Renderer('].join(''))
    expect(source).not.toContain(['SDKMessage', 'RendererProps'].join(''))
    expect(source).not.toContain(['function is', 'Record('].join(''))
    // 活链路：历史与实时统一走 MessageGroupRenderer / AssistantTurnRenderer。
    expect(source).toContain('export function AssistantTurnRenderer')
    expect(source).toContain('export const MessageGroupRenderer')
    expect(source).toContain('export function parseAttachedFiles')
    expect(source).toContain('export function getGroupId')
  })

  test('Given 对话容器 When 检查 Then 空状态组件退役而容器与滚动按钮保留', () => {
    const source = readFileSync(join(rendererRoot, 'components/ai-elements/conversation.tsx'), 'utf8')

    expect(source).not.toContain('ConversationEmptyState')
    expect(source).toContain('export function Conversation(')
    expect(source).toContain('export function ConversationContent(')
    expect(source).toContain('export function ConversationScrollButton(')
  })

  test('Given 渲染入口 When 检查 Then 快捷键初始化只由 GlobalShortcuts 承担', () => {
    const source = readFileSync(join(rendererRoot, 'main.tsx'), 'utf8')

    expect(source).not.toContain('PlanningShortcutInitializer')
    expect(source).not.toContain("from './lib/shortcut-registry'")
    expect(source).toContain('<GlobalShortcuts />')
  })
})