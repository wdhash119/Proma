import { AGENT_RUNTIME_METHODS, DEFAULT_DELEGATION_WAIT_SECONDS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
// AskUserQuestion 属于用户主导的自由文本交互；两分钟不足以完成输入。
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000

/** 协作等待子会话工具：其自身 timeoutSeconds 决定主进程阻塞时长。 */
const WAIT_FOR_DELEGATIONS_TOOL_NAME = 'mcp__collaboration__wait_for_delegations'
/** 协作续跑工具：主进程 handler 同步等到子会话完成，上限见 DEFAULT_DELEGATION_WAIT_SECONDS。 */
const CONTINUE_DELEGATION_TOOL_NAME = 'mcp__collaboration__continue_delegation'
/** 覆盖主进程 IPC 往返与工具结果序列化的额外余量（秒）。 */
const DELEGATION_BRIDGE_MARGIN_SECONDS = 60
const WAIT_FOR_DELEGATIONS_DEFAULT_TIMEOUT_SECONDS = 3600
const WAIT_FOR_DELEGATIONS_MIN_TIMEOUT_SECONDS = 1
const WAIT_FOR_DELEGATIONS_MAX_TIMEOUT_SECONDS = 7200

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * 按 wait_for_delegations 自身的 timeoutSeconds 推导跨进程等待上限。
 *
 * 主进程侧该工具会阻塞到子会话完成或超时，若仍按 120s 拒绝请求，
 * utility 侧会发送 CAPABILITY_CANCEL，把一次正常的长等待误判为失败。
 * 这里与工具参数保持同一钳制区间，并额外留出 IPC 余量。
 */
function resolveWaitForDelegationsTimeoutMs(payload: unknown): number {
  const input = asRecord(asRecord(payload).input)
  const rawSeconds = input.timeoutSeconds
  const seconds = typeof rawSeconds === 'number' && Number.isFinite(rawSeconds)
    ? rawSeconds
    : WAIT_FOR_DELEGATIONS_DEFAULT_TIMEOUT_SECONDS
  const clamped = Math.min(
    Math.max(seconds, WAIT_FOR_DELEGATIONS_MIN_TIMEOUT_SECONDS),
    WAIT_FOR_DELEGATIONS_MAX_TIMEOUT_SECONDS,
  )
  return (clamped + DELEGATION_BRIDGE_MARGIN_SECONDS) * 1000
}

/**
 * Utility Process 请求主进程的等待时间。
 *
 * 以下三类主进程侧会长时间阻塞的语义化能力放宽：
 * - AskUserQuestion：用户在界面上自由输入，两分钟不足以覆盖。
 * - wait_for_delegations：按工具自身 timeoutSeconds 加余量推导。
 * - continue_delegation：handler 同步等到子会话完成，预算与 handler 内部上限一致。
 * 其余能力调用保持 120s，继续用于快速发现主进程真实故障。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number {
  const payloadRecord = asRecord(payload)
  const toolName = payloadRecord.toolName

  if (method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL && toolName === 'AskUserQuestion') {
    return ASK_USER_QUESTION_TIMEOUT_MS
  }

  if (method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL && toolName === WAIT_FOR_DELEGATIONS_TOOL_NAME) {
    return resolveWaitForDelegationsTimeoutMs(payloadRecord)
  }

  // continue_delegation 在 handler 内同步等待子会话完成（上限 DEFAULT_DELEGATION_WAIT_SECONDS）。
  // 若按默认 120s 超时，utility 侧会先发出 CAPABILITY_CANCEL，把正常的长等待误判为失败。
  if (method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL && toolName === CONTINUE_DELEGATION_TOOL_NAME) {
    return (DEFAULT_DELEGATION_WAIT_SECONDS + DELEGATION_BRIDGE_MARGIN_SECONDS) * 1000
  }

  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
