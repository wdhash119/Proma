/**
 * Live Compact 切割事件的展示层
 *
 * 每次 Live Compact 在 turn_end 切下一刀，主进程就发射一条 `system` / `spine_cut`
 * 消息（见 pi-agent-adapter 的 emitCutNotice）。它既进入实时流，也随会话转录持久化
 * （`isPersistableSDKSystemMessage`），因此在历史记录里同样可见。
 *
 * 展示位置：所属 assistant turn 的执行过程信息流内，与工具调用行同级，**按事件实际发生
 * 的时间位置穿插在工具行之间**（`locateSpineCutEvents` 把 turn 内消息顺序换算成顶层块
 * 锚点）。外形沿用弱化工具行风格：Scissors 图标 + 单行 muted 文案。
 *
 * 显示受「显示压缩事件」开关（liveCompactShowEventsAtom）控制：关闭时
 * `locateSpineCutEvents` 返回空数组，实时与历史一并隐藏；开关不影响切割行为与事件发射。
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

/** 切割事件加上它在顶层内容块序列里的插入锚点。 */
export interface SpineCutEvent {
  message: SDKSystemMessage
  /** 该事件之前已经出现的顶层内容块数，即它应插入的下标。 */
  blockIndex: number
}

/**
 * 把 turn 内的切割事件换算成顶层块锚点，保持原始时间顺序（纯函数，便于单测）。
 *
 * `turnMessages` 里的 assistant 消息与 `turn.assistantMessages` 同源同序，因此按
 * `topLevelBlockCounts`（每条 assistant 消息贡献的顶层块数）累加游标，游标即该 cut
 * 之前已存在的顶层块数。cut 一律在某条 assistant 消息收尾之后发射，所以锚点天然落在
 * 对应工具往返之间，不会把事件挤到整轮末尾。
 *
 * `showEvents` 为 false 时返回空数组：开关关闭即实时与历史都不渲染。
 */
export function locateSpineCutEvents(
  turnMessages: SDKMessage[],
  topLevelBlockCounts: readonly number[],
  showEvents: boolean,
): SpineCutEvent[] {
  if (!showEvents) return []
  const located: SpineCutEvent[] = []
  let blockCursor = 0
  let assistantSeen = 0
  for (const message of turnMessages) {
    if (message.type === 'assistant') {
      blockCursor += topLevelBlockCounts[assistantSeen] ?? 0
      assistantSeen += 1
      continue
    }
    if (message.type !== 'system') continue
    const systemMessage = message as SDKSystemMessage
    if (systemMessage.subtype !== 'spine_cut') continue
    located.push({ message: systemMessage, blockIndex: blockCursor })
  }
  return located
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
