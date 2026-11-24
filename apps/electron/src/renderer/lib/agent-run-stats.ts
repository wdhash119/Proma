/**
 * 对话运行中状态行的实时指标（纯函数，无 React、无 DOM，便于单测）。
 *
 * 状态行要显示三件事：当前进行的事项、输出速率、缓存命中率。三者的数据可得性差别很大：
 *
 * - **缓存命中率**：每条主链 assistant 消息都带本次模型调用的精确 usage
 *   （主进程 `adapters/pi-message-adapter.ts` 的 `usageFromAssistant` 写入
 *   `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`），
 *   本轮逐条相加即为turn级用量。分母必须用 `input + cacheRead + cacheWrite`：Pi 各 provider
 *   归一时 `input = promptTokens - cacheRead - cacheWrite`，input 不含缓存，而 SDK 的
 *   `totalTokens` 含 output 且各 provider 组成不同，拿它当分母会低估命中率。
 * - **输出速率**：usage 只在每次模型调用结束时发一次（主进程 `agent-orchestrator.ts` 的
 *   `usage` 分支），一次调用内 token 数是常数，做不出实时感。所以在飞调用只能按字符数估算，
 *   已完成调用用精确 output。估算值可能高于精确值，因此累计计数器取单调不减，
 *   否则速率会在调用结束时因计数回退而抖动。
 * - **当前事项**：文本与思考增量直接写进 `liveMessages` 的 partial 消息，块类型就是当前动作；
 *   工具块只有等 `tool_result` 回填才算结束。
 *
 * 渠道能力差异要显式区分：OpenAI 兼容渠道缺 `prompt_tokens_details` 时缓存字段被写成 0，
 * 与「真的没命中」在数值上无法区分。这里用「分母是否为 0」来判定未知，未知时不显示该项，
 * 而不是显示一个假的 0%。
 */

/** 粗略字符/Token 换算系数，与主进程 thinking token 估算保持同一量级 */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/** 速率统计窗口 */
export const RATE_WINDOW_MS = 6000

/** 窗口内至少要跨这么久才出速率，避免刚起头时把噪声放大 */
export const RATE_MIN_SPAN_MS = 1000

/** 单次模型调用的用量字段（主进程归一后的 snake_case） */
export interface RunStatUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 状态行用到的最小消息结构。字段全部放宽成 unknown，因为 SDK 消息是个宽 union，
 * 直接把 `SDKMessage[]` 传进来要能结构兼容；实际读取处都有运行时收窄。
 */
export interface RunStatMessage {
  type?: string
  parent_tool_use_id?: string | null
  /** SDKSystemMessage 的 message 是字符串，assistant 的是对象，所以这里保持 unknown */
  message?: unknown
}

interface RunStatBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  tool_use_id?: string
}

/** 本轮累计用量（只统计上报了 usage 的主链 assistant 调用） */
export interface RunUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 速率采样点 */
export interface RunTokenSample {
  at: number
  tokens: number
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** `message` 只有对象形态才带 content/usage；system 消息是字符串，直接跳过 */
function messageRecord(message: RunStatMessage): { content?: unknown; usage?: unknown } | null {
  const record = message.message
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  return record as { content?: unknown; usage?: unknown }
}

function readUsage(message: RunStatMessage): RunStatUsage | null {
  const usage = messageRecord(message)?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  return usage as RunStatUsage
}

function contentBlocks(message: RunStatMessage): RunStatBlock[] {
  const content = messageRecord(message)?.content
  return Array.isArray(content) ? (content as RunStatBlock[]) : []
}

/** 主链消息：Task/子 Agent 的 sidechain 消息不参与状态行统计 */
function isMainlineAssistant(message: RunStatMessage): boolean {
  return message.type === 'assistant' && !message.parent_tool_use_id
}

/**
 * 已经在消息列表里出现过的 tool_use_id，用来判断末尾的工具调用是否还在执行。
 */
function collectResolvedToolUseIds(messages: RunStatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id)
      }
    }
  }
  return ids
}

/**
 * 当前进行的事项：`THINKING`、`TEXT`，或正在执行的工具名（如 `Bash`、`Read`）。
 *
 * 取最后一条主链 assistant 消息的最后一个内容块 —— 流式写入总是在末尾追加，
 * 所以末尾块就是正在发生的事。工具块需要确认结果还没回填。
 *
 * @returns 事项标签；还没出现任何模型输出时返回 null
 */
export function describeRunActivity(messages: RunStatMessage[]): string | null {
  let last: RunStatMessage | null = null
  for (const message of messages) {
    if (isMainlineAssistant(message)) last = message
  }
  if (!last) return null

  const blocks = contentBlocks(last)
  const lastBlock = blocks[blocks.length - 1]
  if (!lastBlock?.type) return null

  if (lastBlock.type === 'thinking') return 'THINKING'
  if (lastBlock.type === 'text') return 'TEXT'
  if (lastBlock.type === 'tool_use') {
    const resolved = collectResolvedToolUseIds(messages)
    if (typeof lastBlock.id === 'string' && resolved.has(lastBlock.id)) return 'TEXT'
    return typeof lastBlock.name === 'string' && lastBlock.name ? lastBlock.name : 'TOOL'
  }
  return null
}

/**
 * 本轮累计用量。只累加 `input/output/cache` 至少有一项非零的调用：
 * 重试与失败调用会带上全 0 的 usage，累进去会稀释命中率。
 */
export function sumRunUsage(messages: RunStatMessage[]): RunUsageTotals {
  const totals: RunUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const message of messages) {
    if (!isMainlineAssistant(message)) continue
    const usage = readUsage(message)
    if (!usage) continue
    const pureInput = asNumber(usage.input_tokens)
    const output = asNumber(usage.output_tokens)
    const cacheRead = asNumber(usage.cache_read_input_tokens)
    const cacheWrite = asNumber(usage.cache_creation_input_tokens)
    if (pureInput <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) continue
    totals.input += pureInput
    totals.output += output
    totals.cacheRead += cacheRead
    totals.cacheWrite += cacheWrite
  }
  return totals
}

/**
 * 缓存命中率。分母是本轮全部模型调用实际喂进去的 prompt token（含缓存读写），
 * 不含 output。
 *
 * @returns 0～1；分母为 0（渠道不上报缓存，或本轮还没有用量）时返回 null 表示未知
 */
export function getCacheHitRate(totals: RunUsageTotals): number | null {
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite
  if (promptTokens <= 0) return null
  return Math.min(1, Math.max(0, totals.cacheRead / promptTokens))
}

/**
 * 本轮已产出的 token 估算值：已完成调用用精确 output，仍在流式的调用按字符数估算。
 *
 * 用来做速率的分子。调用结束时精确值可能低于字符估算值，调用方需要把结果钳成单调不减。
 */
export function estimateRunOutputTokens(messages: RunStatMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    if (!isMainlineAssistant(message)) continue
    const exact = asNumber(readUsage(message)?.output_tokens)
    if (exact > 0) {
      tokens += exact
      continue
    }
    let chars = 0
    for (const block of contentBlocks(message)) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
      // 思考内容也是 output 计费的一部分，漏算会明显低估推理模型的速率
      if (block.type === 'thinking' && typeof block.thinking === 'string') chars += block.thinking.length
    }
    tokens += chars / CHARS_PER_TOKEN_ESTIMATE
  }
  return tokens
}

/**
 * 滚动窗口输出速率（token/秒）。
 *
 * @param samples 采样点，按时间升序；调用方需保证 tokens 单调不减
 * @param nowMs 当前时刻
 * @param windowMs 窗口长度
 * @returns token/秒；窗口跨度不足或没有产出时返回 null
 */
export function getTrailingRatePerSecond(
  samples: RunTokenSample[],
  nowMs: number,
  windowMs: number = RATE_WINDOW_MS,
): number | null {
  const windowStart = nowMs - windowMs
  const inWindow = samples.filter((sample) => sample.at >= windowStart)
  if (inWindow.length < 2) return null
  const first = inWindow[0]
  const last = inWindow[inWindow.length - 1]
  if (!first || !last) return null
  const spanMs = last.at - first.at
  if (spanMs < RATE_MIN_SPAN_MS) return null
  const gained = last.tokens - first.tokens
  if (gained <= 0) return null
  return (gained / spanMs) * 1000
}

/**
 * 运行耗时文案：1 秒内给毫秒，1 分钟内给一位小数，超过 1 分钟给 `5m 23s`。
 */
export function formatRunElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  // 59.6s 进位后会出现 "4m 60s"
  if (seconds === 60) return `${minutes + 1}m 0s`
  return `${minutes}m ${seconds}s`
}

/** 命中率文案，一位小数；未知返回 null 由调用方省略该项 */
export function formatCacheHitRate(rate: number | null): string | null {
  if (rate == null) return null
  return `${(rate * 100).toFixed(1)}%`
}

/** 输出速率文案，沿用「T/s」写法；未知返回 null 由调用方省略该项 */
export function formatTokenRate(tokensPerSecond: number | null): string | null {
  if (tokensPerSecond == null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null
  return `${tokensPerSecond.toFixed(1)} T/s`
}
