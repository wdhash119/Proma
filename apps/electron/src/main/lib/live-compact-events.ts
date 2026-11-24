/**
 * Live Compact 决策事件日志（借鉴 MerkyorLynn/pi-live-compact 0.1.4 的 telemetry）。
 * 只记判定与水位数字，不记工具正文；任何写入失败都不得影响会话回合。
 *
 * 落点由接线方给绝对路径（adapter 传 `<configDir>/live-compact/events.jsonl`），
 * 本模块不猜测目录，也不做异步队列：一次 turn_end 最多写几行，同步追加足够。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单文件上限：超过就轮转成 `.1`，避免长会话把事件文件堆成无界增长。 */
const MAX_EVENTS_BYTES = 8 * 1024 * 1024

export interface LiveCompactDecisionEvent {
  /** ISO 时间。 */
  at: string
  sessionId: string
  /** cut / skip / imitation_intercepted / imitation_cap_reached。 */
  event: string
  /** skip 的原因：usage_unknown / length_stop / outcome_aborted / below_pressure 等。 */
  reason?: string
  /** 其余判定与水位数字（hostTokens 等）。禁止放入工具正文或用户内容。 */
  [metric: string]: string | number | boolean | undefined
}

/**
 * 追加一条决策事件。
 *
 * - 目录不存在时自动创建；
 * - 现有文件超过 8MB 时先轮转成 `.1`（覆盖上一份 `.1`），stat 失败按不存在处理；
 * - 写入失败只告警，绝不抛出——事件日志坏了也不能影响正在进行的回合。
 * - `mode` 只在创建文件时生效，Windows 上基本无效：0o600 属于 POSIX 上的尽力而为。
 */
export function appendLiveCompactEvent(eventsPath: string, event: LiveCompactDecisionEvent): void {
  try {
    mkdirSync(dirname(eventsPath), { recursive: true })
    try {
      if (statSync(eventsPath).size > MAX_EVENTS_BYTES) {
        renameSync(eventsPath, `${eventsPath}.1`)
      }
    } catch {
      // 文件还不存在（首次写入）或 stat 失败：直接追加即可。
    }
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  } catch {
    console.warn('[live-compact] events log failed')
  }
}
