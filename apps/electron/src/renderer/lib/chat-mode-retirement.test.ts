import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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
    expect(source).toContain('历史对话数据仍保留在本地；侧栏问答不受影响。')
    expect(source).not.toContain('设置 → 历史 Chat')
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

describe('历史 Chat 入口已移除', () => {
  test('Given 设置面板 When 检查 Then 不再注册历史 Chat 页', () => {
    const source = readFileSync(join(settingsDirectory, 'SettingsPanel.tsx'), 'utf8')

    expect(source).not.toContain('ChatHistorySettings')
    expect(source).not.toContain('chat-history')
  })

  test('Given 历史 Chat 页文件 When 检查 Then 已删除且没有残留引用', () => {
    expect(existsSync(join(settingsDirectory, 'ChatHistorySettings.tsx'))).toBe(false)
  })

  test('Given 历史 Chat 数据层 When 检查 Then 保留列表与迁移 IPC，删除无调用方的死 IPC', () => {
    const preload = readFileSync(join(rendererRoot, '../preload/index.ts'), 'utf8')
    const shared = readFileSync(join(rendererRoot, '../../../../packages/shared/src/types/chat.ts'), 'utf8')
    const mainIpc = readFileSync(join(rendererRoot, '../main/ipc.ts'), 'utf8')

    expect(preload).toContain('listConversations')
    expect(preload).toContain('migrateChatToAgent')
    // 历史 Chat 设置页删除后，删除对话无调用方，四层同步清理；
    // 问答会话内检索（迷你地图搜索完整历史）仍是活链路，必须保留。
    expect(preload).not.toContain('deleteConversation')
    expect(preload).toContain('searchConversationSessionMessages')
    expect(shared).not.toContain('DELETE_CONVERSATION')
    expect(shared).toContain('SEARCH_SESSION_MESSAGES')
    expect(mainIpc).not.toContain('CHAT_IPC_CHANNELS.DELETE_CONVERSATION')
    expect(mainIpc).toContain('CHAT_IPC_CHANNELS.SEARCH_SESSION_MESSAGES')
    expect(preload).not.toContain('toggleArchiveConversation')
    expect(preload).not.toContain('extractAttachmentText')
  })

  test('Given 旧文案入口 When 检查 Then 引导与 FAQ 不再指向已删除的设置页', () => {
    const onboarding = readFileSync(join(rendererRoot, 'components/onboarding/OnboardingView.tsx'), 'utf8')
    const faq = readFileSync(join(rendererRoot, 'components/onboarding/faq-content.ts'), 'utf8')

    expect(onboarding).not.toContain('设置 → 历史 Chat')
    expect(faq).not.toContain('设置 → 历史 Chat')
    expect(faq).toContain('历史对话数据仍然保留在本地')
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
