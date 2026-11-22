/**
 * 微信集成 Jotai 状态
 *
 * 管理微信 Bridge 连接状态。
 */

import { atom } from 'jotai'
import type { WeChatBridgeState } from '@proma/shared'

/** 微信 Bridge 连接状态 */
export const wechatBridgeStateAtom = atom<WeChatBridgeState>({
  status: 'disconnected',
})
