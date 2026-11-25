/**
 * Settings Tab Atom - 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页：
 * - general: 通用设置
 * - channels: 渠道配置
 * - proxy: 代理配置
 * - appearance: 外观设置
 * - about: 关于
 */

import { atom } from 'jotai'
import type { TabType } from './tab-atoms'

/** 全部设置标签页 ID；新增标签页时同步维护，供运行时校验回退使用。 */
const SETTINGS_TAB_IDS = [
  'general',
  'channels',
  'computer-use',
  'live-compact',
  'vision-relay',
  'proxy',
  'appearance',
  'about',
  'onboarding',
  'personas',
  'bots',
  'shortcuts',
  'voice-input',
  'storage',
  'about-you',
] as const

export type SettingsTab = (typeof SETTINGS_TAB_IDS)[number]

/** 设置面板默认标签页（每次打开设置都回到渠道配置）。 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'channels'

/**
 * 已移除标签页的历史值到现存标签页的映射。
 * 'migration'（原「数据迁移」页）已并入 'storage'（现「数据管理」页）。
 */
const LEGACY_SETTINGS_TAB_ALIASES: Record<string, SettingsTab> = {
  migration: 'storage',
}

/**
 * 校验运行时标签页值，未知值（例如已移除的 'chat-history' 或热更新残留状态）
 * 回退默认标签页，避免设置面板空白。
 *
 * 已并入其它页面的历史标签页在 whitelist 判断前先做显式映射，
 * 避免把仍指向旧页面的状态回退成默认页。
 */
export function normalizeSettingsTab(raw: unknown): SettingsTab {
  if (typeof raw === 'string') {
    const aliased = LEGACY_SETTINGS_TAB_ALIASES[raw]
    if (aliased) return aliased
  }
  return typeof raw === 'string' && (SETTINGS_TAB_IDS as readonly string[]).includes(raw)
    ? raw as SettingsTab
    : DEFAULT_SETTINGS_TAB
}

/** 当前设置标签页（不持久化，每次打开设置默认显示渠道） */
export const settingsTabAtom = atom<SettingsTab>(DEFAULT_SETTINGS_TAB)

/** 设置浮窗是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道创建表单是否有未保存内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置面板（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)

/**
 * 从设置工作区离开时暂存的会话导航目标。
 * 渠道表单有未保存内容时，SettingsPanel 确认放弃后再执行该导航。
 */
export interface SettingsSessionNavigation {
  type: TabType
  sessionId: string
  title: string
  /** 导航经设置脏表单确认并真正执行后提交的调用方 intent。 */
  onOpened?: () => void
}
export const settingsPendingSessionNavigationAtom = atom<SettingsSessionNavigation | null>(null)
