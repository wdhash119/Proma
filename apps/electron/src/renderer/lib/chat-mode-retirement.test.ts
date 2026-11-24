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

// ===== 后端 / 共享层防回流 =====

/** 收集任意目录下的 TS 源码（跳过测试文件，避免断言文本命中自己）。 */
function collectTypeScriptSources(directory: string): Array<{ path: string; source: string }> {
  const collected: Array<{ path: string; source: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      collected.push(...collectTypeScriptSources(fullPath))
      continue
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    collected.push({ path: fullPath, source: readFileSync(fullPath, 'utf8') })
  }
  return collected
}

const appRoot = join(rendererRoot, '../..')
const repoRoot = join(appRoot, '../..')
const backendSources = [
  ...collectTypeScriptSources(join(appRoot, 'src/main')),
  ...collectTypeScriptSources(join(appRoot, 'src/preload')),
]
const sharedSources = [
  ...collectTypeScriptSources(join(repoRoot, 'packages/shared/src')),
  ...collectTypeScriptSources(join(repoRoot, 'packages/core/src')),
]

function relativeToRepo(path: string): string {
  return path.slice(repoRoot.length + 1)
}

/** 按整词匹配源码，避免 WECHAT_IPC_CHANNELS 之类的前缀误命中。 */
function sourcesContaining(sources: Array<{ path: string; source: string }>, pattern: string): string[] {
  const escaped = pattern.replace(/[^A-Za-z0-9_]/g, (char) => `\\${char}`)
  const matcher = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`)
  return sources.filter((file) => matcher.test(file.source)).map((file) => relativeToRepo(file.path))
}

describe('Chat 后端专属代码已全部删除', () => {
  test('Given Chat 主进程服务与工具运行时 When 检查 Then 文件均已不存在', () => {
    for (const removed of [
      'apps/electron/src/main/lib/chat-service.ts',
      'apps/electron/src/main/lib/conversation-manager.ts',
      'apps/electron/src/main/lib/document-parser.ts',
      'apps/electron/src/main/lib/document-parser.test.ts',
      'apps/electron/src/main/lib/chat-tool-config.ts',
      'apps/electron/src/main/lib/chat-tool-registry.ts',
      'apps/electron/src/main/lib/chat-tool-executor.ts',
      'apps/electron/src/main/lib/chat-tools-watcher.ts',
      'apps/electron/src/main/lib/chat-tools/agent-recommend-tool.ts',
      'apps/electron/src/main/lib/chat-tools/http-tool-executor.ts',
      'packages/shared/src/types/chat.ts',
      'packages/shared/src/types/chat-tool.ts',
    ]) {
      expect(existsSync(join(repoRoot, removed)), removed).toBe(false)
    }
  })

  test('Given 主进程与 preload When 检查 Then 不再引用 Chat 服务、通道与工具 IPC', () => {
    expect(sourcesContaining(backendSources, 'CHAT_IPC_CHANNELS')).toEqual([])
    expect(sourcesContaining(backendSources, 'CHAT_TOOL_IPC_CHANNELS')).toEqual([])
    expect(sourcesContaining(backendSources, 'MIGRATE_CHAT_TO_AGENT')).toEqual([])
    expect(sourcesContaining(backendSources, 'migrateChatToAgentSession')).toEqual([])
    expect(sourcesContaining(backendSources, 'chat-service')).toEqual([])
    expect(sourcesContaining(backendSources, 'conversation-manager')).toEqual([])
    expect(sourcesContaining(backendSources, 'chat-tool-registry')).toEqual([])
    expect(sourcesContaining(backendSources, 'chat-tool-config')).toEqual([])
    expect(sourcesContaining(backendSources, 'chat-tool-executor')).toEqual([])
    expect(sourcesContaining(backendSources, 'chat-tools-watcher')).toEqual([])
    expect(sourcesContaining(backendSources, 'document-parser')).toEqual([])
    expect(sourcesContaining(backendSources, 'stopAllGenerations')).toEqual([])
  })

  test('Given 通用文件 IPC When 检查 Then 通道中性且四层同步', () => {
    const sharedRuntime = readFileSync(join(repoRoot, 'packages/shared/src/types/runtime.ts'), 'utf8')
    for (const channel of [
      "READ_ATTACHMENT: 'file:read-attachment'",
      "SAVE_IMAGE_AS: 'file:save-image-as'",
      "SAVE_RESOURCE_FILE_AS: 'file:save-resource-file-as'",
      "OPEN_FILE_DIALOG: 'file:open-dialog'",
    ]) {
      expect(sharedRuntime).toContain(channel)
    }
    expect(sharedRuntime).not.toContain("'chat:")

    const mainIpc = readFileSync(join(appRoot, 'src/main/ipc.ts'), 'utf8')
    const preload = readFileSync(join(appRoot, 'src/preload/index.ts'), 'utf8')
    for (const name of ['IPC_CHANNELS.READ_ATTACHMENT', 'IPC_CHANNELS.SAVE_IMAGE_AS', 'IPC_CHANNELS.SAVE_RESOURCE_FILE_AS', 'IPC_CHANNELS.OPEN_FILE_DIALOG']) {
      expect(mainIpc).toContain(name)
      expect(preload).toContain(name)
    }
    // 通用文件能力必须保留：读取附件、另存图片/资源、打开文件对话框
    expect(preload).toContain('readAttachment:')
    expect(preload).toContain('saveImageAs:')
    expect(preload).toContain('saveResourceFileAs:')
    expect(preload).toContain('openFileDialog:')
  })

  test('Given Agent 会话与设置 When 检查 Then 自动归档保留而 Chat 归档已移除', () => {
    const mainIpc = readFileSync(join(appRoot, 'src/main/ipc.ts'), 'utf8')

    expect(mainIpc).not.toContain('autoArchiveConversations')
    expect(mainIpc).toContain('autoArchiveAgentSessions')
    expect(mainIpc).not.toContain('archivedChats')
  })

  test('Given 附件与存储服务 When 检查 Then Chat 保存/删除附件与 chat-tools 路径已移除', () => {
    const attachmentService = readFileSync(join(appRoot, 'src/main/lib/attachment-service.ts'), 'utf8')
    const configPaths = readFileSync(join(appRoot, 'src/main/lib/config-paths.ts'), 'utf8')
    const storageService = readFileSync(join(appRoot, 'src/main/lib/storage-service.ts'), 'utf8')

    expect(attachmentService).not.toContain('saveAttachment')
    expect(attachmentService).not.toContain('deleteAttachment')
    expect(attachmentService).toContain('readAttachmentAsBase64')
    expect(attachmentService).toContain('openFileDialog')

    for (const getter of ['getConversationsDir', 'getConversationAttachmentsDir', 'getAttachmentsDir', 'resolveAttachmentPath', 'getChatToolsConfigPath']) {
      expect(configPaths).not.toContain(getter)
    }

    expect(storageService).not.toContain("'conversations'")
    expect(storageService).not.toContain("'attachments'")
  })
})

describe('共享层类型中性化', () => {
  test('Given 共享类型 When 检查 Then Chat 历史类型与问答注入契约已删除', () => {
    expect(sourcesContaining(sharedSources, 'CHAT_IPC_CHANNELS')).toEqual([])
    expect(sourcesContaining(sharedSources, 'CHAT_TOOL_IPC_CHANNELS')).toEqual([])
    expect(sourcesContaining(sharedSources, 'MIGRATE_CHAT_TO_AGENT')).toEqual([])
    expect(sourcesContaining(sharedSources, 'qaInjection')).toEqual([])
    expect(sourcesContaining(sharedSources, 'QA_BASELINE_SYSTEM_PROMPT')).toEqual([])
    expect(sourcesContaining(sharedSources, 'buildQaSystemMessage')).toEqual([])
    expect(sourcesContaining(sharedSources, 'PersonaQaInjection')).toEqual([])
    expect(sourcesContaining(sharedSources, 'ChatMessage')).toEqual([])
    expect(sourcesContaining(sharedSources, 'ChatToolActivity')).toEqual([])
  })

  test('Given 供应商协议 When 检查 Then 使用中性 ProviderMessage 与附件类型', () => {
    const coreTypes = readFileSync(join(repoRoot, 'packages/core/src/providers/types.ts'), 'utf8')
    const providerTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/provider.ts'), 'utf8')

    expect(coreTypes).toContain('ProviderMessage')
    expect(coreTypes).toContain("from '@proma/shared'")
    expect(providerTypes).toContain('export interface ProviderMessage')
    expect(providerTypes).not.toContain('toolActivities')
  })

  test('Given 人设契约 When 检查 Then Agent 人设构建与示范轮保留', () => {
    const personaTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/persona.ts'), 'utf8')

    expect(personaTypes).toContain('export function buildPersonaPromptSection')
    expect(personaTypes).toContain('primerTurns')
    expect(personaTypes).toContain('BUILTIN_DEFAULT_PERSONA_ID')
  })
})

describe('Chat 退役不误伤正常命名', () => {
  test('Given 飞书与企业 IM When 检查 Then Chat 消息类型与 /chat/completions 协议保留', () => {
    const feishuTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/feishu.ts'), 'utf8')
    const openaiUrlUtils = readFileSync(join(repoRoot, 'packages/core/src/providers/url-utils.ts'), 'utf8')

    expect(feishuTypes).toContain('FeishuChatMessage')
    // OpenAI 兼容协议路径属于供应商协议，不随 Chat 退役删除。
    expect(openaiUrlUtils).toContain('/chat/completions')
  })

  test('Given Agent 会话命名与附件类型 When 检查 Then 保留 Agent 语义与中性附件契约', () => {
    const attachmentTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/attachment.ts'), 'utf8')
    const providerTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/provider.ts'), 'utf8')
    const sessionSearchTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/session-search.ts'), 'utf8')
    const channelTypes = readFileSync(join(repoRoot, 'packages/shared/src/types/channel.ts'), 'utf8')

    expect(attachmentTypes).toContain('export const MAX_ATTACHMENT_SIZE')
    expect(attachmentTypes).toContain('export interface FileAttachment')
    expect(attachmentTypes).toContain('export interface FileOrFolderDialogResult')
    expect(providerTypes).toContain('export interface ProviderMessage')
    expect(sessionSearchTypes).toContain('export interface SessionMessageSearchResult')
    expect(sessionSearchTypes).toContain('export interface SessionMessageSearchResponse')
    expect(channelTypes).toContain('export interface ModelOption')

    // Agent 会话的 conversation 命名属于资产模型，不得被误判为 Chat 残留。
    expect(sourcesContaining(backendSources, 'AgentSession')).not.toEqual([])
  })
})

describe('问答工具 Skill 退役与默认 Skill 防回流', () => {
  const defaultSkillsDir = join(appRoot, 'default-skills')

  function collectDefaultSkillSources(): Array<{ slug: string; source: string }> {
    const collected: Array<{ slug: string; source: string }> = []
    for (const entry of readdirSync(defaultSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillPath = join(defaultSkillsDir, entry.name, 'SKILL.md')
      if (!existsSync(skillPath)) continue
      collected.push({ slug: entry.name, source: readFileSync(skillPath, 'utf8') })
    }
    return collected
  }

  test('Given 默认 Skill 目录 When 检查 Then tool-builder 已随问答侧栏一起下线', () => {
    expect(existsSync(join(defaultSkillsDir, 'tool-builder'))).toBe(false)
  })

  test('Given 配置层 When 检查 Then tool-builder 已登记为退役默认 Skill', () => {
    const configPaths = readFileSync(join(appRoot, 'src/main/lib/config-paths.ts'), 'utf8')
    const retiredBlock = configPaths.match(/RETIRED_DEFAULT_SKILL_SLUGS[^=]*=\s*\[([\s\S]*?)\]/)

    expect(retiredBlock).not.toBeNull()
    expect(retiredBlock?.[1]).toContain("'tool-builder'")
  })

  test('Given 默认 Skill 目录 When 检查 Then 不再残留问答工具语义', () => {
    const offenders = collectDefaultSkillSources()
      .filter((skill) => /tool-builder|chat-tools\.json/.test(skill.source))
      .map((skill) => skill.slug)

    expect(offenders).toEqual([])
  })

  test('Given proma-coach When 检查 Then 版本已递增且不再引导用户创建问答工具', () => {
    const coach = readFileSync(join(defaultSkillsDir, 'proma-coach/SKILL.md'), 'utf8')

    expect(coach).toContain('version: "1.0.16"')
    expect(coach).not.toContain('tool-builder')
    expect(coach).not.toContain('Chat')
    expect(coach).not.toMatch(/问答(工具|侧栏)/)

    // 退役 Chat 相关路由不得连带删掉仍然有效的下游路由。
    expect(coach).toContain('skill-creator')
    expect(coach).toContain('prompt-clarifier')
    expect(coach).toContain('MCP')
  })
})
