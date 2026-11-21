import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const settingsDirectory = join(rendererRoot, 'components/settings')
const appShellDirectory = join(rendererRoot, 'components/app-shell')

describe('Chat 模式退役后的主入口契约', () => {
  test('Given 应用模式 When 检查 Then 唯一生效值为 agent，且拒绝切换', () => {
    const source = readFileSync(join(rendererRoot, 'atoms/app-mode.ts'), 'utf8')

    // 类型保留联合以便既有比较保持合法，但读取值固定 agent。
    expect(source).toContain("() => 'agent'")
    expect(source).toContain("console.warn('[AppMode] Chat 模式已退役，模式切换被忽略')")
  })

  test('Given 标签渲染 When 检查 Then 主入口不再渲染 ChatView', () => {
    const source = readFileSync(join(rendererRoot, 'components/tabs/TabContent.tsx'), 'utf8')

    expect(source).not.toContain("from '@/components/chat'")
    expect(source).toContain('Chat 模式已退役')
    expect(source).toContain('设置 → 历史 Chat')
  })

  test('Given 侧栏 When 检查 Then 模式切换器与 Chat 入口已移除', () => {
    const source = readFileSync(join(appShellDirectory, 'LeftSidebar.tsx'), 'utf8')

    expect(source).not.toContain('ModeSwitcher')
    expect(source).not.toContain('切换到 Chat 模式')
    expect(source).not.toContain('chat-history-heading')
    // 模式固定为 Agent 后，头部「Bot + Agent」模式标签已移除；折叠按钮并入操作行保留。
    expect(source).not.toContain('<span className="truncate">Agent</span>')
    expect(source).toContain('sidebar-collapse-button')
  })

  test('Given 全局快捷键 When 检查 Then 不再提供模式切换', () => {
    const defaults = readFileSync(join(rendererRoot, 'lib/shortcut-defaults.ts'), 'utf8')
    const shortcuts = readFileSync(join(rendererRoot, 'components/shortcuts/GlobalShortcuts.tsx'), 'utf8')

    expect(defaults).not.toContain("id: 'toggle-mode'")
    expect(shortcuts).not.toContain("'toggle-mode'")
  })
})

describe('历史 Chat 归档入口', () => {
  test('Given 设置面板 When 检查 Then 注册了历史 Chat 页', () => {
    const source = readFileSync(join(settingsDirectory, 'SettingsPanel.tsx'), 'utf8')

    expect(source).toContain('ChatHistorySettings')
    expect(source).toContain("id: \"chat-history\"")
  })

  test('Given 历史 Chat 页 When 检查 Then 支持搜索、归档筛选、分页与交给 Agent', () => {
    const source = readFileSync(join(settingsDirectory, 'ChatHistorySettings.tsx'), 'utf8')

    expect(source).toContain('listConversations')
    expect(source).toContain("archiveFilter === 'archived'")
    expect(source).toContain('PAGE_SIZE')
    expect(source).toContain('migrateChatToAgent')
  })

  test('Given 历史 Chat 数据层 When 检查 Then 仍保留检索与迁移 IPC，已移除无调用方的死 IPC', () => {
    const preload = readFileSync(join(rendererRoot, '../preload/index.ts'), 'utf8')

    expect(preload).toContain('listConversations')
    expect(preload).toContain('migrateChatToAgent')
    // 问答正文检索 UI 已随 Chat 主入口退役；searchConversationMessages 无调用方，已清理。
    expect(preload).not.toContain('searchConversationMessages')
    expect(preload).not.toContain('toggleArchiveConversation')
    expect(preload).not.toContain('extractAttachmentText')
  })
})

describe('人设管理取代系统提示词管理', () => {
  test('Given 设置面板 When 检查 Then 注册人设管理页且旧提示词页已移除', () => {
    const source = readFileSync(join(settingsDirectory, 'SettingsPanel.tsx'), 'utf8')

    expect(source).toContain('PersonaSettings')
    expect(source).toContain('id: "personas"')
    expect(source).not.toContain('PromptSettings')
    expect(source).not.toContain('提示词管理')
  })

  test('Given 问答主入口 When 检查 Then 使用人设选择器且旧提示词组件已移除', () => {
    const header = readFileSync(join(rendererRoot, 'components/chat/ChatHeader.tsx'), 'utf8')
    const view = readFileSync(join(rendererRoot, 'components/chat/ChatView.tsx'), 'utf8')

    expect(header).toContain('PersonaSelector')
    expect(header).not.toContain('SystemPromptSelector')
    expect(view).not.toContain('PromptEditorSidebar')
    expect(view).not.toContain('system-prompt-atoms')
  })

  test('Given Agent 输入栏 When 检查 Then 提供会话人设选择器', () => {
    const source = readFileSync(join(rendererRoot, 'components/agent/AgentView.tsx'), 'utf8')

    expect(source).toContain('AgentPersonaPopover')
    expect(source).toContain('updateAgentSessionPersona')
  })
})
