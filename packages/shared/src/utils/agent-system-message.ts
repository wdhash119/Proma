import type { SDKSystemMessage } from '../types/agent'

type SDKCompactStatus = 'compacting' | 'success' | 'failed' | 'noop'

export function getSDKCompactStatus(message: SDKSystemMessage): SDKCompactStatus | undefined {
  if (message.subtype === 'compact_boundary') return 'success'
  if (message.subtype === 'compacting') return 'compacting'

  if (message.subtype !== 'status') return undefined
  if (message.compact_result === 'success' || message.compact_result === 'failed' || message.compact_result === 'noop') {
    return message.compact_result
  }
  if (message.status === 'compacting') return 'compacting'
  if (typeof message.compact_error === 'string' && message.compact_error.trim().length > 0) {
    return 'failed'
  }
  return undefined
}

/**
 * 需要长期持久化、跨重启可见的 system 消息。
 *
 * Live Compact 切割事件（spine_cut）也在此列：它既要在实时流里可见，也要写进
 * 会话转录，否则「显示压缩事件」开关对历史记录永远无效。
 */
export function isPersistableSDKSystemMessage(message: SDKSystemMessage): boolean {
  return message.subtype === 'spine_cut'
    || message.subtype === 'permission_denied'
    || getSDKCompactStatus(message) != null
}

/**
 * 需要独立成组、单独渲染的 system 消息（压缩生命周期状态与权限拒绝）。
 *
 * 与 isPersistableSDKSystemMessage 分开是刻意的：spine_cut 需要持久化，但它是
 * 一次执行过程事件，应进入所属 assistant turn 的执行过程信息流，而不是像压缩状态
 * 那样中断 turn、单独成行。
 */
export function isStandaloneSDKSystemMessage(message: SDKSystemMessage): boolean {
  return message.subtype === 'permission_denied' || getSDKCompactStatus(message) != null
}
