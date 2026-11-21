/**
 * 「按住说话」会话归属守卫
 *
 * 长按由渲染端触发，但真正开始/结束录音由主进程决定。
 * 渲染端的按下与松开是两次独立 IPC，中间可能发生状态漂移（另一处 toggle、全局快捷键、
 * 上一次长按迟到的松开事件），因此主进程必须自己校验这次请求是否仍属于当前会话。
 */

import type { VoicePressToTalkRequest } from '../../types'

/** 听写生命周期状态；与 voice-dictation-window 内的状态机保持一致。 */
export type VoiceDictationLifecycleState = 'idle' | 'active' | 'stopping'

/**
 * 只有空闲且设置里启用了「按住说话」时，才允许开始一次长按会话。
 *
 * 状态非 idle（已在录音或正在收尾）时直接拒绝，交给已有的 toggle 逻辑处理重复触发。
 */
export function canStartVoicePressToTalk(
  state: VoiceDictationLifecycleState,
  enabled: boolean | undefined,
): boolean {
  return state === 'idle' && enabled === true
}

/**
 * 只有同一 token 才能结束本次长按会话。
 *
 * 典型场景：用户快速按一下再按一下，第一次会话的松开事件晚到，
 * 若无 token 校验就会把第二次会话停掉。
 */
export function canStopVoicePressToTalk(
  state: VoiceDictationLifecycleState,
  activeToken: string | null,
  token: string,
): boolean {
  return state === 'active' && activeToken !== null && activeToken === token
}

const MAX_PRESS_TO_TALK_TOKEN_LENGTH = 128

/** 校验渲染端传入的长按事件；任何字段不合法时返回 undefined，退回普通 toggle 语义。 */
export function normalizeVoicePressToTalkRequest(value: unknown): VoicePressToTalkRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { action?: unknown; token?: unknown }
  if (candidate.action !== 'start' && candidate.action !== 'stop') return undefined
  if (typeof candidate.token !== 'string') return undefined
  if (candidate.token.length === 0 || candidate.token.length > MAX_PRESS_TO_TALK_TOKEN_LENGTH) {
    return undefined
  }
  return { action: candidate.action, token: candidate.token }
}
