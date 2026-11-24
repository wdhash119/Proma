import { describe, expect, test } from 'bun:test'
import {
  describeRunActivity,
  estimateRunOutputTokens,
  formatCacheHitRate,
  formatRunElapsed,
  formatTokenRate,
  getCacheHitRate,
  getTrailingRatePerSecond,
  RUN_METRICS_REFRESH_MS,
  RUN_STATS_TICK_MS,
  shouldRefreshRunMetrics,
  sumRunUsage,
  type RunStatMessage,
  type RunTokenSample,
} from './agent-run-stats'

/** 造一条主链 assistant 消息 */
function assistant(content: unknown[], usage?: Record<string, number>, options?: { sidechain?: boolean }): RunStatMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: options?.sidechain ? 'toolu_parent' : null,
    message: { content, ...(usage ? { usage } : {}) },
  }
}

const TEXT = (text: string) => ({ type: 'text', text })
const THINKING = (thinking: string) => ({ type: 'thinking', thinking })
const TOOL_USE = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} })
const TOOL_RESULT = (id: string) => ({ type: 'tool_result', tool_use_id: id })

describe('当前事项判定', () => {
  test('Given 末尾块是 thinking When 判定事项 Then 返回 THINKING', () => {
    expect(describeRunActivity([assistant([TEXT('开头'), THINKING('正在推理')])])).toBe('THINKING')
  })

  test('Given 末尾块是 text When 判定事项 Then 返回 TEXT', () => {
    expect(describeRunActivity([assistant([THINKING('想完了'), TEXT('正在输出')])])).toBe('TEXT')
  })

  test('Given 末尾块是还没回填结果的 tool_use When 判定事项 Then 返回工具名', () => {
    expect(describeRunActivity([assistant([TOOL_USE('toolu_1', 'Bash')])])).toBe('Bash')
  })

  test('Given tool_use 已经有 tool_result When 判定事项 Then 不再报工具名', () => {
    const messages = [
      assistant([TOOL_USE('toolu_1', 'Bash')]),
      { type: 'user', message: { content: [TOOL_RESULT('toolu_1')] } } as RunStatMessage,
      assistant([TEXT('在读结果')]),
    ]
    expect(describeRunActivity(messages)).toBe('TEXT')
  })

  test('Given 还没有任何 assistant 消息 When 判定事项 Then 返回 null', () => {
    expect(describeRunActivity([{ type: 'user', message: { content: [TEXT('用户输入')] } } as RunStatMessage])).toBeNull()
  })

  test('Given 最后一条是子 Agent 的消息 When 判定事项 Then 只看主链消息', () => {
    const messages = [
      assistant([TEXT('主链正在输出')]),
      assistant([TOOL_USE('toolu_9', 'Read')], undefined, { sidechain: true }),
    ]
    expect(describeRunActivity(messages)).toBe('TEXT')
  })

  test('Given 多条 assistant 消息 When 判定事项 Then 取最后一条的末尾块', () => {
    const messages = [assistant([TOOL_USE('toolu_1', 'Grep')]), assistant([THINKING('新一轮思考')])]
    expect(describeRunActivity(messages)).toBe('THINKING')
  })

  test('Given system 消息的 message 是字符串 When 判定事项 Then 不参与也不报错', () => {
    const messages = [{ type: 'system', message: 'init' } as unknown as RunStatMessage, assistant([TEXT('输出中')])]
    expect(describeRunActivity(messages)).toBe('TEXT')
  })
})

describe('本轮用量与缓存命中率', () => {
  test('Given 两次调用分别读缓存 900 与 1000 When 计算命中率 Then 按全部 prompt token 计算', () => {
    const totals = sumRunUsage([
      assistant([], { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }),
      assistant([], { input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 30 }),
    ])
    expect(totals).toEqual({ input: 100, output: 80, cacheRead: 1900, cacheWrite: 0 })
    expect(getCacheHitRate(totals)).toBeCloseTo(1900 / 2000, 6)
  })

  test('Given 重试调用上报全 0 用量 When 汇总 Then 跳过，不稀释命中率', () => {
    const totals = sumRunUsage([
      assistant([], { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 }),
      assistant([], { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
    ])
    expect(getCacheHitRate(totals)).toBeCloseTo(0.9, 6)
  })

  test('Given 渠道不上报缓存导致分母为 0 When 计算命中率 Then 返回 null 而不是假的 0%', () => {
    expect(getCacheHitRate(sumRunUsage([assistant([], { output_tokens: 120 })]))).toBeNull()
  })

  test('Given 只有子 Agent 上报用量 When 汇总 Then 不计入本轮用量', () => {
    const totals = sumRunUsage([assistant([], { input_tokens: 500 }, { sidechain: true })])
    expect(totals.input).toBe(0)
  })

  test('Given 消息没有 usage When 汇总 Then 各项为 0 且不抛错', () => {
    expect(sumRunUsage([assistant([TEXT('半截输出')])])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('输出 token 估算', () => {
  test('Given 调用已完成 When 估算本轮输出 Then 用精确 output 而不是字符数', () => {
    expect(estimateRunOutputTokens([assistant([TEXT('x'.repeat(400))], { output_tokens: 90 })])).toBe(90)
  })

  test('Given 调用还在流式 When 估算本轮输出 Then 按字符数除以 4 估算', () => {
    expect(estimateRunOutputTokens([assistant([TEXT('x'.repeat(200))])])).toBe(50)
  })

  test('Given 思考与正文同时在流式 When 估算本轮输出 Then 思考字符也计入', () => {
    const tokens = estimateRunOutputTokens([assistant([THINKING('x'.repeat(100)), TEXT('x'.repeat(100))])])
    expect(tokens).toBe(50)
  })

  test('Given 混合已完成与在飞调用 When 估算本轮输出 Then 两者相加', () => {
    const tokens = estimateRunOutputTokens([
      assistant([TEXT('x'.repeat(400))], { output_tokens: 80 }),
      assistant([TEXT('x'.repeat(80))]),
    ])
    expect(tokens).toBe(100)
  })
})

describe('滚动窗口输出速率', () => {
  const samples: RunTokenSample[] = [
    { at: 10_000, tokens: 0 },
    { at: 11_000, tokens: 100 },
    { at: 12_000, tokens: 250 },
  ]

  test('Given 采样跨 2 秒产出 250 token When 计算速率 Then 得到每秒 125 token', () => {
    expect(getTrailingRatePerSecond(samples, 12_000)).toBeCloseTo(125, 6)
  })

  test('Given 窗口跨度不足 1 秒 When 计算速率 Then 返回 null，不显示刚起头的噪声', () => {
    expect(getTrailingRatePerSecond([{ at: 12_000, tokens: 10 }, { at: 12_500, tokens: 60 }], 12_500)).toBeNull()
  })

  test('Given 只有一个采样点 When 计算速率 Then 返回 null', () => {
    expect(getTrailingRatePerSecond([{ at: 12_000, tokens: 100 }], 12_000)).toBeNull()
  })

  test('Given 窗口内没有新增 token When 计算速率 Then 返回 null', () => {
    expect(getTrailingRatePerSecond([{ at: 11_000, tokens: 100 }, { at: 12_000, tokens: 100 }], 12_000)).toBeNull()
  })

  test('Given 采样早于 6 秒窗口 When 计算速率 Then 只统计窗口内增量', () => {
    const longTail: RunTokenSample[] = [{ at: 1_000, tokens: 5000 }, ...samples.map((s) => ({ ...s, tokens: s.tokens + 5000 }))]
    expect(getTrailingRatePerSecond(longTail, 12_000, 1_500)).toBeCloseTo(150, 6)
  })
})

describe('状态行文案', () => {
  test('Given 各种耗时 When 格式化 Then 秒内取毫秒、分钟内一位小数、分钟级取整秒', () => {
    expect(formatRunElapsed(900)).toBe('900ms')
    expect(formatRunElapsed(12_400)).toBe('12.4s')
    expect(formatRunElapsed(323_000)).toBe('5m 23s')
    expect(formatRunElapsed(239_600)).toBe('4m 0s')
    expect(formatRunElapsed(-5)).toBe('0ms')
  })

  test('Given 命中率 When 格式化 Then 一位小数且未知返回 null', () => {
    expect(formatCacheHitRate(0.9823)).toBe('98.2%')
    expect(formatCacheHitRate(null)).toBeNull()
  })

  test('Given 速率 When 格式化 Then 保留一位小数且非正值返回 null', () => {
    expect(formatTokenRate(105.34)).toBe('105.3 T/s')
    expect(formatTokenRate(0)).toBeNull()
    expect(formatTokenRate(null)).toBeNull()
  })
})

describe('状态行刷新节奏', () => {
  test('Given 节奏常量 When 检查 Then tick 1s、缓存/速率快照 5s', () => {
    expect(RUN_STATS_TICK_MS).toBe(1000)
    expect(RUN_METRICS_REFRESH_MS).toBe(5000)
  })

  test('Given 距上次快照不足 5s When 判定 Then 不刷新缓存/速率', () => {
    expect(shouldRefreshRunMetrics(10_000, 14_999)).toBe(false)
  })

  test('Given 距上次快照恰好 5s When 判定 Then 刷新', () => {
    expect(shouldRefreshRunMetrics(10_000, 15_000)).toBe(true)
  })

  test('Given 自定义间隔 When 判定 Then 按传入间隔裁决', () => {
    expect(shouldRefreshRunMetrics(0, 1999, 2000)).toBe(false)
    expect(shouldRefreshRunMetrics(0, 2000, 2000)).toBe(true)
  })
})
