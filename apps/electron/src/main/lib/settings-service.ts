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
import type {
  AppSettings,
  LiveCompactLineAbsolute,
  LiveCompactLineRatios,
  LiveCompactSettings,
} from '../../types'
import { getTerminalProfilesForPlatform, isTerminalProfile } from '@proma/shared'
import { normalizeVisionRelaySettings } from './vision-relay-policy'
import {
  DEFAULT_LIVE_COMPACT_LINE_ABSOLUTE,
  DEFAULT_LIVE_COMPACT_LINE_RATIOS,
} from './adapters/live-compact-thresholds'

/** 比例组的合法区间：0 = 永不触发，1 = 任何占用都触发，两边都不可用。 */
const LINE_RATIO_MIN = 0.01
const LINE_RATIO_MAX = 0.99
/** 绝对值组的合法区间：1 token 到一千万 token（足够覆盖已出现的 1M 级窗口）。 */
const LINE_TOKENS_MIN = 1
const LINE_TOKENS_MAX = 10_000_000

/** 取有限数值并夹到区间内；类型不对或非有限值返回 undefined（由调用方整组回落）。 */
function clampLineNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/** 整数 token：先来区间夹取，再四舍五入（token 数不接受小数）。 */
function clampLineTokens(value: unknown): number | undefined {
  const clamped = clampLineNumber(value, LINE_TOKENS_MIN, LINE_TOKENS_MAX)
  return clamped === undefined ? undefined : Math.round(clamped)
}

/**
 * 归一化比例组。
 *
 * 逐字段 clamp 到 0.01..0.99；任一项缺失/类型不对，或组内不是
 * `keepRound ≤ trigger < urgent < bigGate`，整组回落缺省 0.5 / 0.35 / 0.75 / 0.9。
 */
function normalizeLiveCompactLineRatios(input: unknown): LiveCompactLineRatios {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const trigger = clampLineNumber(raw.trigger, LINE_RATIO_MIN, LINE_RATIO_MAX)
  const keepRound = clampLineNumber(raw.keepRound, LINE_RATIO_MIN, LINE_RATIO_MAX)
  const urgent = clampLineNumber(raw.urgent, LINE_RATIO_MIN, LINE_RATIO_MAX)
  const bigGate = clampLineNumber(raw.bigGate, LINE_RATIO_MIN, LINE_RATIO_MAX)
  if (trigger === undefined || keepRound === undefined || urgent === undefined || bigGate === undefined) {
    return { ...DEFAULT_LIVE_COMPACT_LINE_RATIOS }
  }
  const ordered = keepRound <= trigger && trigger < urgent && urgent < bigGate
  return ordered
    ? { trigger, keepRound, urgent, bigGate }
    : { ...DEFAULT_LIVE_COMPACT_LINE_RATIOS }
}

/**
 * 归一化绝对值组。
 *
 * 逐字段 clamp 到 1..10_000_000；任一项缺失/类型不对，或不是
 * `trigger < urgent < bigGate`，整组回落上游 Origin 默认 20000 / 32000 / 48000 / 650000。
 * 注意这里**不**校验 `keepRound ≤ trigger`：上游 Origin 就是 32000 > 20000。
 */
function normalizeLiveCompactLineAbsolute(input: unknown): LiveCompactLineAbsolute {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const triggerTokens = clampLineTokens(raw.triggerTokens)
  const keepRoundTokens = clampLineTokens(raw.keepRoundTokens)
  const urgentTokens = clampLineTokens(raw.urgentTokens)
  const bigGateTokens = clampLineTokens(raw.bigGateTokens)
  if (
    triggerTokens === undefined
    || keepRoundTokens === undefined
    || urgentTokens === undefined
    || bigGateTokens === undefined
  ) {
    return { ...DEFAULT_LIVE_COMPACT_LINE_ABSOLUTE }
  }
  const ordered = triggerTokens < urgentTokens && urgentTokens < bigGateTokens
  return ordered
    ? { triggerTokens, keepRoundTokens, urgentTokens, bigGateTokens }
    : { ...DEFAULT_LIVE_COMPACT_LINE_ABSOLUTE }
}

/**
 * 容错读取 Live Compact 设置：只有显式 true 才启用，未知/损坏值一律视为关闭。
 * 手写 settings.json 可能写成 `{}` 或非布尔值，不能让它们变成“意外开启”。
 *
 * 新增的四条线/保护开关字段必须在这里显式保留：本函数是读取侧的归一化边界，
 * 没被返回的字段会在“读取 → 保存”一来一回里被默默丢掉。整个函数不抛异常：
 * 任一子组不合法只回落到该组默认值。
 */
export function normalizeLiveCompactSettings(input: unknown): LiveCompactSettings {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return {
    enabled: raw.enabled === true,
    // 缺省保护（ec918f21 的当前轮护栏）：只有显式 false 才关。
    protectCurrentTurn: raw.protectCurrentTurn !== false,
    lineMode: raw.lineMode === 'absolute' ? 'absolute' : 'ratio',
    ratios: normalizeLiveCompactLineRatios(raw.ratios),
    absolute: normalizeLiveCompactLineAbsolute(raw.absolute),
  }
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
      visionRelay: normalizeVisionRelaySettings(undefined),
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
      // 旧 enabled 设置只在此归一化边界迁移为 mode，运行逻辑不再读取 enabled。
      visionRelay: normalizeVisionRelaySettings(data.visionRelay),
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
      visionRelay: normalizeVisionRelaySettings(undefined),
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
    // 视觉助手：本次部分更新与已存路由合并后统一归一化，非法 mode 不可能经 IPC 落盘。
    visionRelay: updates.visionRelay === undefined
      ? normalizeVisionRelaySettings(current.visionRelay)
      : normalizeVisionRelaySettings({ ...current.visionRelay, ...updates.visionRelay }),
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
