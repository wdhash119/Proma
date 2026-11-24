/**
 * Channel Atoms — 渠道与模型选择器的跨视图共享状态
 *
 * Chat 模式已退役，但渠道列表与「模型选择器」开合状态仍被 Agent 主会话、
 * 自动化表单、视觉中继等入口复用，因此独立于任何单一会话类型维护。
 */

import { atom } from 'jotai'
import type { Channel } from '@proma/shared'

/** 全局渠道列表缓存（启动时加载一次，设置变更时刷新） */
export const channelsAtom = atom<Channel[]>([])

/** 渠道列表是否已完成首次加载 */
export const channelsLoadedAtom = atom(false)

/** 主输入框「模型选择器」是否打开（错误卡片的「重新选择模型」按钮会置 true） */
export const modelSelectorOpenAtom = atom(false)
