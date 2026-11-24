/**
 * SpineCutNotice - Live Compact 切割事件通知行
 *
 * 渲染 subtype 为 `spine_cut` 的 system 消息：每次 Live Compact 在 turn_end 切下一刀，
 * 主进程就发射一条这样的消息（见 pi-agent-adapter 的 emitCutNotice）。与官方压缩的
 * CompactionNotice 不同，它是**持久化转录条目**，常驻显示、不自动消失——重新加载会话
 * 后仍在，方便复盘上下文在哪一轮被改写。
 *
 * 显示受「显示压缩事件」开关（liveCompactShowEventsAtom）控制：关闭时返回 null，
 * 历史记录一并隐藏；开关只影响显示，不影响切割行为与事件发射。
 * 样式沿用 CompactionNotice 的单行弱化风格（左缩进对齐消息正文、muted 小字）。
 */

import * as React from 'react'
import { Scissors } from 'lucide-react'
import { useAtomValue } from 'jotai'
import type { SDKSystemMessage } from '@proma/shared'
import { liveCompactShowEventsAtom } from '@/atoms/agent-atoms'

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

export function SpineCutNotice({ message }: { message: SDKSystemMessage }): React.ReactElement | null {
  const showEvents = useAtomValue(liveCompactShowEventsAtom)
  if (!showEvents) return null
  return (
    <div className="pl-[56px] pr-4 py-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Scissors className="size-3" />
        <span>{buildSpineCutNoticeText(message)}</span>
      </div>
    </div>
  )
}