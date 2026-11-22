/**
 * 飞书集成 Jotai 状态（多 Bot 版本）
 *
 * 管理多个飞书 Bot 的 Bridge 连接状态和聊天绑定。
 */

import { atom } from 'jotai'
import type {
  FeishuChatBinding,
  FeishuBotBridgeState,
} from '@proma/shared'

/** 多 Bot Bridge 状态（botId → 状态） */
export const feishuBotStatesAtom = atom<Record<string, FeishuBotBridgeState>>({})

/** 飞书聊天绑定列表（含 botId） */
export const feishuBindingsAtom = atom<FeishuChatBinding[]>([])
