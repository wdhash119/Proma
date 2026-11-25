/**
 * 配置路径工具
 *
 * 管理 Proma 应用的本地配置文件路径。
 * 所有用户配置存储在 ~/.proma/ 目录下。
 */

import { join, basename, isAbsolute } from 'node:path'
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { rmSyncWithRetry } from './fs-retry'

/**
 * 获取配置目录名称
 *
 * 开发模式下返回 '.proma-dev'，正式版本返回 '.proma'。
 *
 * 检测优先级：
 * 1. PROMA_DEV=1 环境变量（显式覆盖）
 * 2. Electron app.isPackaged（未打包 = 开发模式）
 * 3. 兜底 '.proma'
 */
let _configDirName: string | undefined

export function getConfigDirName(): string {
  if (_configDirName === undefined) {
    if (process.env.PROMA_DEV === '1') {
      _configDirName = '.proma-dev'
    } else {
      try {
        const { app } = require('electron')
        _configDirName = app.isPackaged ? '.proma' : '.proma-dev'
      } catch {
        _configDirName = '.proma'
      }
    }
    const mode = _configDirName === '.proma-dev' ? '开发模式' : '正式版本'
    console.log(`[配置] 配置目录: ~/${_configDirName}/（${mode}）`)
  }
  return _configDirName
}

/**
 * 数据根指针文件
 *
 * 存放于默认数据根（~/.proma 或 ~/.proma-dev）之下，指向用户迁移后的实际数据目录。
 * 缺失即表示使用默认位置；损坏或目标缺失时回退默认位置，不删除指针、不抛错。
 */
export const DATA_ROOT_POINTER_FILENAME = 'data-root.json'

export interface DataRootPointer {
  version: 1
  /** 迁移后的数据根绝对路径 */
  target: string
  /** 迁移完成时间（ISO 8601） */
  migratedAt: string
}

/**
 * 默认数据根：不读取指针的原始位置。
 *
 * 迁移服务需要同时拿到“用户当前的根”和“默认根”才能判断是否已迁移，
 * 因此这里只按目录名拼接，不做任何目录创建或指针解析。
 */
export function getDefaultConfigDir(): string {
  return join(homedir(), getConfigDirName())
}

/** 默认数据根下的指针文件路径。 */
export function getDataRootPointerPath(): string {
  return join(getDefaultConfigDir(), DATA_ROOT_POINTER_FILENAME)
}

/**
 * 读取并解析指针文件（纯读取，不创建目录、不缓存）。
 *
 * 返回 null 表示没有可用指针：文件缺失、JSON 损坏、版本不符或 target 非法。
 * 指针损坏时不删除文件，便于用户排查；调用方自行决定是否 warning。
 */
export function readDataRootPointer(defaultRoot: string): DataRootPointer | null {
  const pointerPath = join(defaultRoot, DATA_ROOT_POINTER_FILENAME)
  if (!existsSync(pointerPath)) return null

  try {
    const raw = readFileSync(pointerPath, 'utf-8')
    const data = JSON.parse(raw) as Partial<DataRootPointer> | null
    if (!data || typeof data !== 'object') return null
    if (data.version !== 1) return null
    if (typeof data.target !== 'string' || !isAbsolute(data.target)) return null
    if (typeof data.migratedAt !== 'string') return null
    return { version: 1, target: data.target, migratedAt: data.migratedAt }
  } catch (error) {
    console.warn('[配置] 读取数据目录指针失败，回退默认目录:', error)
    return null
  }
}

/**
 * 按指针解析出实际数据根（纯函数，不缓存、不创建目录）。
 *
 * 只有指针合法且目标目录存在时才返回目标；否则回退 defaultRoot。
 * 目标目录必须是目录而不是同名文件，避免把文件当数据根。
 */
export function resolveConfigDirFromDefault(defaultRoot: string): string {
  const pointer = readDataRootPointer(defaultRoot)
  if (!pointer) return defaultRoot

  try {
    if (!statSync(pointer.target).isDirectory()) {
      console.warn('[配置] 数据目录指针目标不是目录，回退默认目录:', pointer.target)
      return defaultRoot
    }
  } catch {
    console.warn('[配置] 数据目录指针目标不存在，回退默认目录:', pointer.target)
    return defaultRoot
  }

  return pointer.target
}

/**
 * 模块级缓存的数据根解析结果，按默认根键控。
 *
 * 迁移只写指针，不改变当前进程使用的根；重启后才会生效，因此同一默认根下解析结果保持稳定。
 * 键控而非单值缓存：测试会 mock node:os 的 homedir 到临时目录，默认根变化时必须重新解析，
 * 否则先加载的模块会把真实数据根钉死，导致后续测试的 fixture 路径全部错位。
 */
let _resolvedConfigDirCache: { defaultRoot: string; resolved: string } | undefined

/**
 * 解析当前生效的数据根，但不创建目录。
 *
 * 供只需要路径、不希望产生 mkdir 副作用的只读探测使用（如 computer-use 驱动探测）。
 */
export function resolveConfigDir(): string {
  const defaultRoot = getDefaultConfigDir()
  if (_resolvedConfigDirCache && _resolvedConfigDirCache.defaultRoot === defaultRoot) {
    return _resolvedConfigDirCache.resolved
  }
  // 解析过程只做同步文件读取，不得回调 getConfigDir / resolveConfigDir 自身，避免递归。
  const resolved = resolveConfigDirFromDefault(defaultRoot)
  _resolvedConfigDirCache = { defaultRoot, resolved }
  if (resolved !== defaultRoot) {
    console.log(`[配置] 使用自定义数据目录: ${resolved}`)
  }
  return resolved
}

/**
 * 获取配置目录路径
 *
 * 优先使用 data-root.json 指向的自定义数据根，否则使用默认根
 * （开发模式 ~/.proma-dev/，正式版本 ~/.proma/）。
 * 如果目录不存在则自动创建。
 */
export function getConfigDir(): string {
  const configDir = resolveConfigDir()

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
    console.log(`[配置] 已创建配置目录: ${configDir}`)
  }

  return configDir
}

/** 仅供测试：清空数据根解析缓存，让下一次 getConfigDir() 重新解析指针。 */
export function resetConfigDirCacheForTests(): void {
  _resolvedConfigDirCache = undefined
}

/**
 * 获取渠道配置文件路径
 *
 * @returns ~/.proma/channels.json
 */
export function getChannelsPath(): string {
  return join(getConfigDir(), 'channels.json')
}

/**
 * 获取应用设置文件路径
 *
 * @returns ~/.proma/settings.json
 */
export function getSettingsPath(): string {
  return join(getConfigDir(), 'settings.json')
}

/**
 * 获取用户授权的 Markdown Vault 配置路径。
 * 内容仅保存 Vault 根目录与用户授予的能力，不保存笔记正文或索引。
 */
export function getVaultConfigPath(): string {
  return join(getConfigDir(), 'vault.json')
}

/**
 * 解析 Proma 管理的默认 Markdown Vault 目录。
 */
export function resolveDefaultVaultDir(configDir: string): string {
  return join(configDir, 'vault')
}

/**
 * 获取 Proma 管理的默认 Markdown Vault 目录，并在首次使用时创建。
 *
 * @returns 正式版本 ~/.proma/vault/，开发模式 ~/.proma-dev/vault/
 */
export function getDefaultVaultDir(configDir = getConfigDir()): string {
  const dir = resolveDefaultVaultDir(configDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建默认 Vault 目录: ${dir}`)
  }
  return dir
}

/**
 * 获取系统默认 App 探测缓存路径
 *
 * @returns ~/.proma/default-apps.json
 */
export function getDefaultAppsCachePath(): string {
  return join(getConfigDir(), 'default-apps.json')
}

/**
 * 获取用户档案文件路径
 *
 * @returns ~/.proma/user-profile.json
 */
export function getUserProfilePath(): string {
  return join(getConfigDir(), 'user-profile.json')
}

/**
 * 获取代理配置文件路径
 *
 * @returns ~/.proma/proxy-settings.json
 */
export function getProxySettingsPath(): string {
  return join(getConfigDir(), 'proxy-settings.json')
}

/**
 * 获取系统提示词配置文件路径
 *
 * @returns ~/.proma/system-prompts.json
 */
export function getSystemPromptsPath(): string {
  return join(getConfigDir(), 'system-prompts.json')
}

/**
 * 人设配置文件路径
 *
 * @returns ~/.proma/personas.json
 */
export function getPersonasPath(): string {
  return join(getConfigDir(), 'personas.json')
}

/**
 * 获取第三方 MCP OAuth 凭据的加密索引路径。
 *
 * 文件只保存 Electron safeStorage 加密后的 payload，不会写入任何工作区 mcp.json。
 */
export function getMcpOAuthCredentialsPath(): string {
  return join(getConfigDir(), 'mcp-oauth-credentials.json')
}

/**
 * 获取 Agent 会话索引文件路径
 *
 * @returns ~/.proma/agent-sessions.json
 */
export function getAgentSessionsIndexPath(): string {
  return join(getConfigDir(), 'agent-sessions.json')
}

/**
 * 获取 Agent 会话消息目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/agent-sessions/
 */
export function getAgentSessionsDir(): string {
  const dir = join(getConfigDir(), 'agent-sessions')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 会话的消息文件路径
 *
 * @param id 会话 ID
 * @returns ~/.proma/agent-sessions/{id}.jsonl
 */
export function getAgentSessionMessagesPath(id: string): string {
  return join(getAgentSessionsDir(), `${id}.jsonl`)
}

/**
 * 获取 Agent 工作区索引文件路径
 *
 * @returns ~/.proma/agent-workspaces.json
 */
export function getAgentWorkspacesIndexPath(): string {
  return join(getConfigDir(), 'agent-workspaces.json')
}

/**
 * 获取 Agent 工作区根目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/agent-workspaces/
 */
export function getAgentWorkspacesDir(): string {
  const dir = join(getConfigDir(), 'agent-workspaces')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区目录: ${dir}`)
  }

  return dir
}

/**
 * 获取指定 Agent 工作区的目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/
 */
export function getAgentWorkspacePath(slug: string): string {
  const dir = join(getAgentWorkspacesDir(), slug)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 工作区: ${dir}`)
  }

  return dir
}

/**
 * 获取指定工作区的 MCP 配置文件路径
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/mcp.json
 */
export function getWorkspaceMcpPath(slug: string): string {
  return join(getAgentWorkspacePath(slug), 'mcp.json')
}

/**
 * 获取指定工作区的 Skills 目录路径
 *
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/skills/
 */
export function getWorkspaceSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取工作区文件目录路径
 *
 * 工作区内所有会话可访问的文件存放于此。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/workspace-files/
 */
export function getWorkspaceFilesDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'workspace-files')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 解析 Agent 会话工作目录路径（只读，不创建目录）
 *
 * 与 getAgentSessionWorkspacePath 的区别：不会触发 mkdir 副作用，
 * 适用于 /now 等只读查询场景。
 *
 * @param slug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.proma/agent-workspaces/{slug}/{sessionId}/
 */
export function resolveAgentSessionWorkspacePath(slug: string, sessionId: string): string {
  return join(getConfigDir(), 'agent-workspaces', slug, sessionId)
}

/**
 * 获取工作区不活跃 Skills 目录路径
 *
 * 禁用的 Skill 会被移动到此目录，Agent SDK 不会扫描该目录。
 * 如果目录不存在则自动创建。
 *
 * @param slug 工作区 slug
 * @returns ~/.proma/agent-workspaces/{slug}/skills-inactive/
 */
export function getInactiveSkillsDir(slug: string): string {
  const dir = join(getAgentWorkspacePath(slug), 'skills-inactive')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取用户级全局 Skills 目录路径
 *
 * 这是跨工作区生效的只读 Skills 来源：Pi 资源加载器把它作为额外的
 * additionalSkillPaths 根目录，因此其中的 Skill 对所有工作区可见。
 * 该目录不由 Proma 创建或管理，不存在时由调用方自行跳过。
 *
 * @returns ~/.AGENTS/skills/
 */
export function getUserAgentsSkillsDir(): string {
  return join(homedir(), '.AGENTS', 'skills')
}

/**
 * 获取默认 Skills 模板目录路径
 *
 * 新建工作区时自动复制此目录的内容到工作区 skills/ 下。
 *
 * @returns ~/.proma/default-skills/
 */
export function getDefaultSkillsDir(): string {
  const dir = join(getConfigDir(), 'default-skills')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  return dir
}

/**
 * 获取打包进 App 的 proma CLI 二进制路径。
 *
 * 打包模式下从 process.resourcesPath/bin 取（electron-builder extraResources 注入）。
 * 开发模式下没有编译二进制——返回 undefined，由调用方回退到源码运行
 * （bun apps/cli/src/index.ts）。
 *
 * @returns 二进制绝对路径；不存在时返回 undefined
 */
export function getBundledCliPath(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined
  const binName = process.platform === 'win32' ? 'proma.exe' : 'proma'
  const cliPath = join(process.resourcesPath, 'bin', binName)
  return existsSync(cliPath) ? cliPath : undefined
}

/**
 * 从 SKILL.md 的 YAML frontmatter 中解析 version 字段
 *
 * 无 version 字段时返回 '0.0.0'（确保旧 Skill 会被更新）。
 */
export function parseSkillVersion(skillDir: string): string {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return '0.0.0'

  try {
    let content = readFileSync(skillMdPath, 'utf-8')
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!fmMatch?.[1]) return '0.0.0'

    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'version' && value) return value
    }
  } catch {
    // 解析失败视为最低版本
  }

  return '0.0.0'
}

/** 比较两个 semver 版本字符串
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 已从 App bundle 移除、但仍需在既有用户目录中清理的默认 Skills。
 *
 * 不根据 bundle 中缺失的目录自动删除，避免误删用户自行安装的 Skills；
 * 后续退役某个内置 Skill 时，显式把它的 slug 加到这里。
 */
export const RETIRED_DEFAULT_SKILL_SLUGS: readonly string[] = [
  'brainstorming',
  'vault',
  // Chat 主入口与侧栏「问答」均已下线，问答类工具改为 MCP 服务或直接 HTTP 请求。
  'tool-builder',
]

const RETIRED_DEFAULT_SKILL_SLUG_SET = new Set(RETIRED_DEFAULT_SKILL_SLUGS)

export function isRetiredDefaultSkill(slug: string): boolean {
  return RETIRED_DEFAULT_SKILL_SLUG_SET.has(slug)
}

/** 清理 ~/.proma/default-skills/ 中已退役的内置 Skill 缓存。 */
function removeRetiredDefaultSkills(dir = getDefaultSkillsDir()): void {
  for (const slug of RETIRED_DEFAULT_SKILL_SLUGS) {
    const target = join(dir, slug)
    if (!existsSync(target)) continue

    try {
      rmSyncWithRetry(target, { recursive: true, force: true })
      console.log(`[配置] 已移除退役默认 Skill: ${slug}`)
    } catch (err) {
      console.warn(`[配置] 移除退役默认 Skill 失败 (${slug}):`, err)
    }
  }
}

/** 防御性目录基名集合：复制 default skills 时永远跳过这些目录，避免
 *  .git 0444 文件、node_modules 文件爆炸等场景把启动期同步链路炸掉。 */
const DEFAULT_SKILL_COPY_BLOCKLIST = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.turbo',
  '__pycache__',
])

function defaultSkillCopyFilter(src: string): boolean {
  return !DEFAULT_SKILL_COPY_BLOCKLIST.has(basename(src))
}

/**
 * 从 app bundle 同步默认 Skills 到 ~/.proma/default-skills/
 *
 * 打包模式下从 process.resourcesPath/default-skills 复制。
 * 开发模式下从源码 default-skills/ 目录复制。
 *
 * - 缺失的 Skill：直接复制
 * - 已存在的 Skill：比较 SKILL.md 中的 version，bundled 更新时才覆盖
 *   （避免每次启动同步 4MB+ 文件阻塞主进程）
 */
export function seedDefaultSkills(): void {
  const { app } = require('electron')
  const bundledDir = app.isPackaged
    ? join(process.resourcesPath, 'default-skills')
    : join(__dirname, '../default-skills')
  const userDir = getDefaultSkillsDir()

  removeRetiredDefaultSkills(userDir)

  if (!existsSync(bundledDir)) {
    console.log('[配置] 未找到内置 default-skills 目录，跳过')
    return
  }

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const source = join(bundledDir, entry.name)
      const target = join(userDir, entry.name)

      try {
        if (!existsSync(target)) {
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已同步默认 Skill: ${entry.name}`)
          continue
        }

        const bundledVer = parseSkillVersion(source)
        const existingVer = parseSkillVersion(target)

        if (compareSemver(bundledVer, existingVer) > 0) {
          // rm-then-cp：rmSync 不依赖目标文件写权限（只读 .git/objects/ 等
          // 0444 文件用 cpSync({ force: true }) 无法覆盖会 EACCES，但
          // rmSync({ force: true }) 只需父目录可写就能 unlink）。
          rmSync(target, { recursive: true, force: true })
          cpSync(source, target, { recursive: true, filter: defaultSkillCopyFilter })
          console.log(`[配置] 已升级默认 Skill: ${entry.name} (${existingVer} → ${bundledVer})`)
        }
      } catch (err) {
        // 单 skill 失败不影响其他 skill 同步。这里吞错是为了防止启动期 bootstrap
        // 链路被任意一个 skill 的同步异常掀翻——窗口和托盘必须先出来。
        console.warn(`[配置] 同步默认 Skill 失败 (${entry.name})，跳过:`, err)
      }
    }
  } catch (err) {
    console.warn('[配置] 同步默认 Skills 失败:', err)
  }
}

/**
 * 获取微信配置文件路径
 *
 * @returns ~/.proma/wechat.json
 */
export function getWeChatConfigPath(): string {
  return join(getConfigDir(), 'wechat.json')
}

/**
 * 获取微信长轮询同步游标路径
 *
 * @returns ~/.proma/wechat-sync.json
 */
export function getWeChatSyncPath(): string {
  return join(getConfigDir(), 'wechat-sync.json')
}

/**
 * 获取微信聊天绑定持久化路径
 *
 * @returns ~/.proma/wechat-bindings.json
 */
export function getWeChatBindingsPath(): string {
  return join(getConfigDir(), 'wechat-bindings.json')
}

/**
 * 获取钉钉配置文件路径
 *
 * @returns ~/.proma/dingtalk.json
 */
export function getDingTalkConfigPath(): string {
  return join(getConfigDir(), 'dingtalk.json')
}

/**
 * 获取某个钉钉 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.proma/dingtalk-bindings-{botId}.json
 */
export function getDingTalkBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `dingtalk-bindings-${botId}.json`)
}

/** 获取 Slack 配置文件路径（~/.proma/slack.json）。 */
export function getSlackConfigPath(): string {
  return join(getConfigDir(), 'slack.json')
}

/** 获取单个 Slack Bot 的 thread → Proma session 绑定文件。 */
export function getSlackBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `slack-bindings-${botId}.json`)
}

/**
 * 获取单个 Slack Bot 的可恢复 delivery ledger。
 * 它只保存发送状态与已准备的终态文本，不保存 token 或原始外部事件。
 */
export function getSlackBotDeliveryPath(botId: string): string {
  return join(getConfigDir(), `slack-delivery-${botId}.json`)
}

/**
 * 获取飞书配置文件路径
 *
 * @returns ~/.proma/feishu.json
 */
export function getFeishuConfigPath(): string {
  return join(getConfigDir(), 'feishu.json')
}

/**
 * 获取某个飞书 Bot 的聊天绑定持久化路径
 *
 * @returns ~/.proma/feishu-bindings-{botId}.json
 */
export function getFeishuBotBindingsPath(botId: string): string {
  return join(getConfigDir(), `feishu-bindings-${botId}.json`)
}

/**
 * 获取某个飞书 Bot 的运行时元数据持久化路径
 *
 * 用于保存最近交互用户 open_id 等需要跨进程重启恢复的状态。
 *
 * @returns ~/.proma/feishu-metadata-{botId}.json
 */
export function getFeishuBotMetadataPath(botId: string): string {
  return join(getConfigDir(), `feishu-metadata-${botId}.json`)
}

/**
 * 获取指定 Agent 会话的工作路径
 *
 * 在工作区目录下创建以 sessionId 命名的子文件夹，
 * 作为该会话的独立 Agent cwd。如果目录不存在则自动创建。
 *
 * @param workspaceSlug 工作区 slug
 * @param sessionId 会话 ID
 * @returns ~/.proma/agent-workspaces/{slug}/{sessionId}/
 */
export function getAgentSessionWorkspacePath(workspaceSlug: string, sessionId: string): string {
  const dir = join(getAgentWorkspacePath(workspaceSlug), sessionId)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent 会话工作目录: ${dir}`)
  }

  return dir
}

/**
 * 获取 SDK 隔离配置目录路径
 *
 * 用于保存 Pi session artifact 等运行时数据，
 * 而不是用户的 ~/.claude.json，实现 Proma 与 Claude Code CLI 的配置隔离。
 *
 * 如果目录不存在则自动创建。
 *
 * @returns ~/.proma/sdk-config/
 */
export function getSdkConfigDir(): string {
  const dir = join(getConfigDir(), 'sdk-config')

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 SDK 配置目录: ${dir}`)
  }

  return dir
}

/**
 * 获取定时任务（Automation）配置文件路径
 *
 * @returns ~/.proma/automations.json
 */
export function getAutomationsPath(): string {
  return join(getConfigDir(), 'automations.json')
}

/** 获取任务/日程 SQLite 数据库路径。 */
export function getPlanningDatabasePath(): string {
  return join(getConfigDir(), 'planning.db')
}
