import { atom } from 'jotai'
import type { SlackBotBridgeState } from '@proma/shared'

/** Slack Bot 状态（botId → 连接状态）。 */
export const slackBotStatesAtom = atom<Record<string, SlackBotBridgeState>>({})
