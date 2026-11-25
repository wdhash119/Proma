import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS, DEFAULT_DELEGATION_WAIT_SECONDS } from '@proma/shared'
import { ASK_USER_QUESTION_TIMEOUT_MS, getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

const DEFAULT_TIMEOUT_MS = 120_000

/** 构造协作等待工具的跨进程请求载荷。 */
function waitPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    queryId: 'query-1',
    sessionId: 'session-1',
    toolName: 'mcp__collaboration__wait_for_delegations',
    toolCallId: 'call-1',
    input,
  }
}

describe('跨进程请求超时推导', () => {
  test('Given continue_delegation When 推导超时 Then 与 handler 上限一致并留 60 秒余量', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'mcp__collaboration__continue_delegation',
      input: { delegationId: 'delegation-1', message: '继续' },
    })

    expect(timeout).toBe((DEFAULT_DELEGATION_WAIT_SECONDS + 60) * 1000)
    expect(timeout).toBe(3660 * 1000)
  })

  test('Given continue_delegation When 载荷缺少参数 Then 仍按固定预算放宽而不回退 120 秒', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'mcp__collaboration__continue_delegation',
    })

    expect(timeout).toBe((DEFAULT_DELEGATION_WAIT_SECONDS + 60) * 1000)
  })

  test('Given 普通能力调用 When 未声明特殊语义 Then 保持 120 秒故障检测', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'mcp__collaboration__delegate_agent',
      input: { timeoutSeconds: 3600 },
    })

    expect(timeout).toBe(DEFAULT_TIMEOUT_MS)
  })

  test('Given AskUserQuestion When 用户自由输入 Then 延长到 15 分钟', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {
      toolName: 'AskUserQuestion',
    })

    expect(timeout).toBe(ASK_USER_QUESTION_TIMEOUT_MS)
    expect(ASK_USER_QUESTION_TIMEOUT_MS).toBe(15 * 60_000)
  })

  test('Given 等待工具声明 timeoutSeconds When 推导超时 Then 在工具时长上追加 60 秒余量', () => {
    const timeout = getParentRequestTimeoutMs(
      AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL,
      waitPayload({ timeoutSeconds: 600 }),
    )

    expect(timeout).toBe((600 + 60) * 1000)
  })

  test('Given 等待工具未声明 timeoutSeconds When 推导超时 Then 使用 3600 秒默认值', () => {
    const timeout = getParentRequestTimeoutMs(
      AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL,
      waitPayload({}),
    )

    expect(timeout).toBe((3600 + 60) * 1000)
  })

  test('Given 等待工具声明超过上限 When 推导超时 Then 钳制到 7200 秒', () => {
    const timeout = getParentRequestTimeoutMs(
      AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL,
      waitPayload({ timeoutSeconds: 99_999 }),
    )

    expect(timeout).toBe((7200 + 60) * 1000)
  })

  test('Given 等待工具声明非法载荷 When 推导超时 Then 回退默认值而不抛错', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      toolName: 'mcp__collaboration__wait_for_delegations',
      input: 'not-an-object',
    })

    expect(timeout).toBe((3600 + 60) * 1000)
  })

  test('Given 同名工具但方法不是自定义工具 When 推导超时 Then 不套用等待工具规则', () => {
    const timeout = getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, waitPayload({ timeoutSeconds: 7200 }))

    expect(timeout).toBe(DEFAULT_TIMEOUT_MS)
  })
})
