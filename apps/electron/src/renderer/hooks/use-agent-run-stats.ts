import * as React from 'react'
import {
  RATE_WINDOW_MS,
  describeRunActivity,
  estimateRunOutputTokens,
  formatCacheHitRate,
  formatRunElapsed,
  formatTokenRate,
  getCacheHitRate,
  getTrailingRatePerSecond,
  sumRunUsage,
  type RunStatMessage,
  type RunTokenSample,
} from '@/lib/agent-run-stats'

/** 状态行的刷新节奏；采样窗口 6s，200ms 足够平滑，也不需要每帧重算 */
const TICK_MS = 200

export interface AgentRunStats {
  /** 已运行毫秒数 */
  elapsedMs: number
  /** 当前事项标签（THINKING / TEXT / 工具名），未知为 null */
  activity: string | null
  /** 耗时文案，如 `5m 23s` */
  elapsedText: string
  /** 缓存命中率文案，如 `98.2%`；渠道不上报缓存时为 null */
  cacheHitRateText: string | null
  /** 输出速率文案，如 `105.3 T/s`；窗口不足或没有产出时为 null */
  tokenRateText: string | null
}

/**
 * 汇总运行中状态行需要的实时指标：当前事项、耗时、缓存命中率、输出速率。
 *
 * @param messages 本轮实时消息（`agentLiveMessagesAtomFamily`），不是整段历史
 * @param startedAt 本轮开始时刻；恢复的会话可能为空，退化为组件挂载时刻
 */
export function useAgentRunStats(messages: RunStatMessage[], startedAt?: number): AgentRunStats {
  // 单调不减的 token 计数器：调用结束时精确 output 可能低于在飞时的字符估算，
  // 不钳住会让速率窗口出现负增量。
  const tokenCountRef = React.useRef(0)
  const samplesRef = React.useRef<RunTokenSample[]>([])
  const mountAtRef = React.useRef(Date.now())
  const [, setTick] = React.useState(0)

  const estimatedTokens = React.useMemo(() => estimateRunOutputTokens(messages), [messages])
  const activity = React.useMemo(() => describeRunActivity(messages), [messages])
  const cacheHitRateText = React.useMemo(
    () => formatCacheHitRate(getCacheHitRate(sumRunUsage(messages))),
    [messages],
  )

  React.useEffect(() => {
    if (estimatedTokens > tokenCountRef.current) tokenCountRef.current = estimatedTokens
  }, [estimatedTokens])

  React.useEffect(() => {
    const sample = (): void => {
      const at = Date.now()
      samplesRef.current.push({ at, tokens: tokenCountRef.current })
      const cutoff = at - RATE_WINDOW_MS
      while (samplesRef.current.length > 0) {
        const oldest = samplesRef.current[0]
        if (!oldest || oldest.at >= cutoff) break
        samplesRef.current.shift()
      }
      setTick((value) => value + 1)
    }
    sample()
    const timer = setInterval(sample, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const nowMs = Date.now()
  const startMs = startedAt ?? mountAtRef.current
  const elapsedMs = Math.max(0, nowMs - startMs)

  return {
    elapsedMs,
    activity,
    elapsedText: formatRunElapsed(elapsedMs),
    cacheHitRateText,
    tokenRateText: formatTokenRate(getTrailingRatePerSecond(samplesRef.current, nowMs)),
  }
}
