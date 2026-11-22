/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import { DEFAULT_THEME_MODE, normalizeDisabledUserSkillSlugs, normalizeProductivityToolsSettings } from '../../types'
import type { AppSettings, LiveCompactSettings } from '../../types'
import { getTerminalProfilesForPlatform, isTerminalProfile } from '@proma/shared'

/**
 * 容错读取 Live Compact 设置：只有显式 true 才启用，未知/损坏值一律视为关闭。
 * 手写 settings.json 可能写成 `{}` 或非布尔值，不能让它们变成“意外开启”。
 */
function normalizeLiveCompactSettings(input: unknown): LiveCompactSettings {
  const raw = input && typeof input === 'object' ? input as Partial<LiveCompactSettings> : {}
  return { enabled: raw.enabled === true }
}

function sanitizeWindowsTerminalProfile(input: unknown): AppSettings['lastWindowsTerminalProfile'] {
  return isTerminalProfile(input) && getTerminalProfilesForPlatform('win32').includes(input)
    ? input
    : undefined
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      liveCompact: { enabled: false },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
      productivityTools: normalizeProductivityToolsSettings(undefined),
      disabledUserSkillSlugs: [],
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings> & {
      experimentalAgentRuntimeSwitchEnabled?: boolean
      agentRuntime?: unknown
      agentChannelIds?: unknown
      builtinMcpDisabledIds?: unknown
      interfaceVariant?: unknown
      /** PR #1895 早期构建写入的无平台 profile 字段；仅在 Windows 上迁移。 */
      lastTerminalProfile?: unknown
    }
    // Pi-only：读取时丢弃旧 runtime selector、界面风格与 Claude 白名单，避免下次写回复活。
    const {
      experimentalAgentRuntimeSwitchEnabled: _legacyRuntimeSwitch,
      agentRuntime: _legacyAgentRuntime,
      agentChannelIds: _legacyAgentChannelIds,
      builtinMcpDisabledIds: _legacyBuiltinMcpDisabledIds,
      interfaceVariant: _legacyInterfaceVariant,
      lastTerminalProfile: legacyLastTerminalProfile,
      ...settings
    } = data
    return {
      ...settings,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      visionRelay: data.visionRelay ?? { enabled: false },
      // 缺省关闭：老配置文件没有该字段时，Live Compact 不参与任何会话。
      liveCompact: normalizeLiveCompactSettings(data.liveCompact),
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      lastWindowsTerminalProfile: process.platform === 'win32'
        ? sanitizeWindowsTerminalProfile(settings.lastWindowsTerminalProfile ?? legacyLastTerminalProfile)
        : undefined,
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      // 缺省 true：老配置文件未写该字段时保持推广默认开启
      gitAttributionEnabled: settings.gitAttributionEnabled ?? true,
      // 缺省全部开启：老配置文件不会因升级意外隐藏生产力工具。
      productivityTools: normalizeProductivityToolsSettings(data.productivityTools),
      // 旧配置没有该字段时视为没有禁用任何用户级 Skill。
      disabledUserSkillSlugs: normalizeDisabledUserSkillSlugs(data.disabledUserSkillSlugs),
      // 仅保留 macOS 原生 Island 开关；清理旧非原生 surface 的持久化残留字段。
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      visionRelay: { enabled: false },
      liveCompact: { enabled: false },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
      productivityTools: normalizeProductivityToolsSettings(undefined),
      disabledUserSkillSlugs: [],
    }
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = {
    ...current,
    ...updates,
    // 仅保留 macOS 原生 Island 开关，避免旧非原生 surface 字段被继续回写。
    productivityTools: updates.productivityTools === undefined
      ? normalizeProductivityToolsSettings(current.productivityTools)
      : normalizeProductivityToolsSettings({ ...current.productivityTools, ...updates.productivityTools }),
    disabledUserSkillSlugs: updates.disabledUserSkillSlugs === undefined
      ? normalizeDisabledUserSkillSlugs(current.disabledUserSkillSlugs)
      : normalizeDisabledUserSkillSlugs(updates.disabledUserSkillSlugs),
    // Live Compact 写入同样容错：非布尔 enabled 一律落回 false，避免“意外开启”。
    liveCompact: updates.liveCompact === undefined
      ? normalizeLiveCompactSettings(current.liveCompact)
      : normalizeLiveCompactSettings({ ...current.liveCompact, ...updates.liveCompact }),
  }
  const filePath = getSettingsPath()

  try {
    // 原子写：崩溃或强制关机时不会留下截断的 settings.json。
    writeJsonFileAtomic(filePath, updated)
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
