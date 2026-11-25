/**
 * SDK system 消息的分类契约：
 * - isPersistableSDKSystemMessage：需要写进会话转录、跨重启可见的消息；
 * - isStandaloneSDKSystemMessage：需要中断 turn、单独成行渲染的消息。
 *
 * 两者的差集只有 Live Compact 的 spine_cut：它要持久化，但必须作为执行过程行
 * 留在所属 assistant turn 内，不能变成独立状态行。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKSystemMessage } from '../types/agent'
import {
  isPersistableSDKSystemMessage,
  isStandaloneSDKSystemMessage,
} from './agent-system-message'

function systemMessage(partial: Partial<SDKSystemMessage>): SDKSystemMessage {
  return { type: 'system', ...partial }
}

describe('isPersistableSDKSystemMessage', () => {
  test('Given Live Compact 切割事件 When 判断持久化 Then 需要持久化', () => {
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'spine_cut' }))).toBe(true)
    expect(isPersistableSDKSystemMessage(systemMessage({
      subtype: 'spine_cut',
      spineCutCount: 3,
      spineSavedTokens: 1200,
      spineDrain: true,
    }))).toBe(true)
  })

  test('Given 权限拒绝或压缩状态 When 判断持久化 Then 保持原有行为', () => {
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'permission_denied' }))).toBe(true)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'compacting' }))).toBe(true)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'compact_boundary' }))).toBe(true)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'status', compact_result: 'success' }))).toBe(true)
  })

  test('Given 运行期同步类消息 When 判断持久化 Then 不持久化', () => {
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'init' }))).toBe(false)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'task_started' }))).toBe(false)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'task_progress' }))).toBe(false)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'task_notification' }))).toBe(false)
    expect(isPersistableSDKSystemMessage(systemMessage({ subtype: 'thinking_tokens' }))).toBe(false)
  })
})

describe('isStandaloneSDKSystemMessage', () => {
  test('Given Live Compact 切割事件 When 判断独立成组 Then 不独立（进入执行过程流）', () => {
    expect(isStandaloneSDKSystemMessage(systemMessage({ subtype: 'spine_cut' }))).toBe(false)
  })

  test('Given 权限拒绝或压缩状态 When 判断独立成组 Then 独立成组', () => {
    expect(isStandaloneSDKSystemMessage(systemMessage({ subtype: 'permission_denied' }))).toBe(true)
    expect(isStandaloneSDKSystemMessage(systemMessage({ subtype: 'compacting' }))).toBe(true)
    expect(isStandaloneSDKSystemMessage(systemMessage({ subtype: 'compact_boundary' }))).toBe(true)
    expect(isStandaloneSDKSystemMessage(systemMessage({ subtype: 'status', compact_status: 'failed' }))).toBe(false)
  })

  test('Given 只有持久化不独立的消息 When 对比两个谓词 Then 仅 spine_cut 落在差集里', () => {
    const subtypes = ['spine_cut', 'permission_denied', 'compacting', 'compact_boundary', 'init', 'task_started']
    const onlyPersistable = subtypes.filter((subtype) => {
      const message = systemMessage({ subtype })
      return isPersistableSDKSystemMessage(message) && !isStandaloneSDKSystemMessage(message)
    })
    expect(onlyPersistable).toEqual(['spine_cut'])
  })
})
