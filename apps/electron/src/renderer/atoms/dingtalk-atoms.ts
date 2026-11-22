/**
 * 钉钉集成 Jotai 状态（多 Bot 版本）
 *
 * 管理多个钉钉 Bot 的 Bridge 连接状态。
 */

import { atom } from 'jotai'
import type { DingTalkBotBridgeState } from '@proma/shared'

/** 所有 Bot 的状态（botId → 状态） */
export const dingtalkBotStatesAtom = atom<Record<string, DingTalkBotBridgeState>>({})
