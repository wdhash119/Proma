import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const settingsDirectory = join(rendererRoot, 'components/settings')
const appShellDirectory = join(rendererRoot, 'components/app-shell')

/** 收集渲染层全部源码（跳过测试文件本身，避免断言文本命中自己）。 */
function collectRendererSources(directory: string): Array<{ path: string; source: string }> {
  const collected: Array<{ path: string; source: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      collected.push(...collectRendererSources(fullPath))
      continue
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    collected.push({ path: fullPath, source: readFileSync(fullPath, 'utf8') })
  }
  return collected
}

const rendererSources = collectRendererSources(rendererRoot)

function findSourcesContaining(pattern: string): string[] {
  return rendererSources
    .filter((file) => file.source.includes(pattern))
    .map((file) => file.path.slice(rendererRoot.length + 1))
}

describe('Chat 前端专属代码已全部删除', () => {
  test('Given Chat 组件树与状态模块 When 检查 Then 文件均已不存在', () => {
    const removedPaths = [
      'components/chat',
      'atoms/chat-atoms.ts',
      'atoms/chat-tool-atoms.ts',
      'atoms/app-mode.ts',
      'hooks/useGlobalChatListeners.ts',
      'hooks/useConversationSettings.ts',
      'lib/side-chat.ts',
    ]

    for (const relativePath of removedPaths) {
      expect(existsSync(join(rendererRoot, relativePath)), relativePath).toBe(false)
    }
  })

  test('Given 渲染层源码 When 检查 Then 不再引用 Chat 组件、状态与监听器', () => {
    expect(findSourcesContaining('components/chat')).toEqual([])
    expect(findSourcesContaining('atoms/chat-atoms')).toEqual([])
    expect(findSourcesContaining('atoms/chat-tool-atoms')).toEqual([])
    expect(findSourcesContaining('atoms/app-mode')).toEqual([])
    expect(findSourcesContaining('appModeAtom')).toEqual([])
    expect(findSourcesContaining('useGlobalChatListeners')).toEqual([])
    expect(findSourcesContaining('useConversationSettings')).toEqual([])
    expect(findSourcesContaining('lib/side-chat')).toEqual([])
    expect(findSourcesContaining('ChatView')).toEqual([])
    expect(findSourcesContaining('chatToolsAtom')).toEqual([])
  })

  test('Given 标签状态 When 检查 Then 标签类型只剩 agent 与 preview', () => {
    const source = readFileSync(join(rendererRoot, 'atoms/tab-atoms.ts'), 'utf8')

    expect(source).toContain("export type TabType = 'agent' | 'preview'")
    expect(source).not.toContain("'chat'")
    expect(source).not.toContain('streamingConversationIdsAtom')
  })

  test('Given 标签渲染 When 检查 Then 主入口不再有 Chat 占位分支', () => {
    const source = readFileSync(join(rendererRoot, 'components/tabs/TabContent.tsx'), 'utf8')

    expect(source).not.toContain('Chat 模式已退役')
    expect(source).not.toContain("tab.type === 'chat'")
    expect(source).not.toContain('设置 → 历史 Chat')
  })

  test('Given 渲染入口 When 检查 Then 不再挂载 Chat 监听器与工具初始化', () => {
    const source = readFileSync(join(rendererRoot, 'main.tsx'), 'utf8')

    expect(source).not.toContain('ChatListenersInitializer')
    expect(source).not.toContain('ChatToolInitializer')
    expect(source).not.toContain('selectedModelAtom')
    // 历史 Chat 标签仍可能残留在持久化 tabState 中，恢复时必须静默过滤。
    expect(source).toContain("t.type === 'agent'")
  })
})

describe('Chat 退役后的主入口契约', () => {
  test('Given 侧栏 When 检查 Then 模式切换器与 Chat 入口已移除', () => {
    const source = readFileSync(join(appShellDirectory, 'LeftSidebar.tsx'), 'utf8')

    expect(source).not.toContain('ModeSwitcher')
    expect(source).not.toContain('切换到 Chat 模式')
    expect(source).not.toContain('chat-history-heading')
    // 模式固定为 Agent 后，头部「Bot + Agent」模式标签已移除；折叠按钮并入操作行保留。
    expect(source).not.toContain('<span className="truncate">Agent</span>')
    expect(source).toContain('sidebar-collapse-button')
    expect(source).not.toContain('listConversations')
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

  test('Given 旧文案入口 When 检查 Then 引导与 FAQ 不再指向已删除的设置页', () => {
    const onboarding = readFileSync(join(rendererRoot, 'components/onboarding/OnboardingView.tsx'), 'utf8')
    const faq = readFileSync(join(rendererRoot, 'components/onboarding/faq-content.ts'), 'utf8')

    expect(onboarding).not.toContain('设置 → 历史 Chat')
    expect(faq).not.toContain('设置 → 历史 Chat')
    // 历史 Chat 数据已按用户授权物理清理，引导与 FAQ 不得再承诺数据仍保留在本地。
    expect(faq).not.toContain('仍然保留在本地')
    expect(onboarding).not.toContain('仍然保留在本地')
    expect(faq).toContain('Chat 主入口已移除')
  })

  test('Given 选区提问引导 When 检查文案 Then 准确区分临时 Agent 与探索分支的上下文继承', () => {
    const onboarding = readFileSync(join(rendererRoot, 'components/onboarding/OnboardingView.tsx'), 'utf8')
    const faq = readFileSync(join(rendererRoot, 'components/onboarding/faq-content.ts'), 'utf8')

    expect(onboarding).toContain('打开临时 Agent')
    expect(onboarding).toContain('探索此分支')
    expect(onboarding).toContain('不继承任何会话历史')
    expect(onboarding).toContain('继承分叉点之前的全部对话历史')
    expect(faq).toContain('会继承分叉点之前的完整对话历史')
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

  test('Given 人设状态 When 检查 Then 只保留 Agent 共享的人设配置与默认人设', () => {
    const source = readFileSync(join(rendererRoot, 'atoms/persona-atoms.ts'), 'utf8')

    expect(source).toContain('personaConfigAtom')
    expect(source).toContain('defaultPersonaIdAtom')
    expect(source).not.toContain('selectedPersonaIdAtom')
    expect(source).not.toContain('conversationPersonaIdAtom')
    expect(source).not.toContain('resolvePersonaSystemMessage')
  })

  test('Given Agent 输入栏 When 检查 Then 提供会话人设选择器', () => {
    const source = readFileSync(join(rendererRoot, 'components/agent/AgentView.tsx'), 'utf8')

    expect(source).toContain('AgentPersonaPopover')
    expect(source).toContain('updateAgentSessionPersona')
  })
})
