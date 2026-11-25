/**
 * Live Compact 切割事件的展示层
 *
 * 每次 Live Compact 在 turn_end 切下一刀，主进程就发射一条 `system` / `spine_cut`
 * 消息（见 pi-agent-adapter 的 emitCutNotice）。它既进入实时流，也随会话转录持久化
 * （`isPersistableSDKSystemMessage`），因此在历史记录里同样可见。
 *
 * 展示位置：所属 assistant turn 的执行过程信息流内，与工具调用行同级、排在过程末尾
 * （cut 在 turn_end 发射，语义上就是这一轮过程收尾时发生的事）。外形沿用弱化工具行
 * 风格：Scissors 图标 + 单行 muted 文案。
 *
 * 显示受「显示压缩事件」开关（liveCompactShowEventsAtom）控制：关闭时
 * `collectSpineCutEvents` 返回空数组，实时与历史一并隐藏；开关不影响切割行为与事件发射。
 */

import * as React from 'react'
import { Scissors } from 'lucide-react'
import type { SDKMessage, SDKSystemMessage } from '@proma/shared'

/**
 * 通知文案（纯函数，便于单测）：切了几段、省多少 token，drain 时标注强制收尾。
 * 字段缺失或非法时回落「上下文已就地压缩」，不渲染空数字。
 */
export function buildSpineCutNoticeText(message: SDKSystemMessage): string {
  const count = typeof message.spineCutCount === 'number' && message.spineCutCount > 0
    ? Math.floor(message.spineCutCount)
    : 0
  const saved = typeof message.spineSavedTokens === 'number' && message.spineSavedTokens > 0
    ? Math.floor(message.spineSavedTokens)
    : 0
  const parts: string[] = []
  if (count > 0) parts.push(`切下 ${count} 段`)
  if (saved > 0) parts.push(`节省约 ${saved.toLocaleString()} tokens`)
  const detail = parts.length > 0 ? parts.join('，') : '上下文已就地压缩'
  const drain = message.spineDrain === true ? '（强制收尾）' : ''
  return `Spine 压缩：${detail}${drain}`
}

/**
 * 从一轮消息里挑出切割事件，保持原始时间顺序（纯函数，便于单测）。
 *
 * `showEvents` 为 false 时返回空数组：开关关闭即实时与历史都不渲染。
 */
export function collectSpineCutEvents(messages: SDKMessage[], showEvents: boolean): SDKSystemMessage[] {
  if (!showEvents) return []
  const events: SDKSystemMessage[] = []
  for (const message of messages) {
    if (message.type !== 'system') continue
    const systemMessage = message as SDKSystemMessage
    if (systemMessage.subtype === 'spine_cut') events.push(systemMessage)
  }
  return events
}

/**
 * 过程流内的切割事件行：与普通工具行同级、同样的缩进与字号，但不可展开。
 */
export function SpineCutProcessRow({ message }: { message: SDKSystemMessage }): React.ReactElement {
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left">
      <Scissors className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground/70">
        {buildSpineCutNoticeText(message)}
      </span>
    </div>
  )
}
