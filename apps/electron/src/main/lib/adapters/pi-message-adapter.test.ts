import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage } from '@proma/shared'
import {
  convertPiMessage,
  convertResultMessage,
  getPiAssistantErrorDetails,
  hasPiAssistantTextContent,
  stripPiAssistantError,
} from './pi-message-adapter'

function writeToolCall(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as AssistantMessage
}

describe('convertPiMessage', () => {
  test('keeps complete write input in the final tool-call frame', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1', undefined, {
      uuid: 'assistant-1',
    }) as { message: { content: Array<{ input?: Record<string, unknown> }> } }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('only exposes terminal Pi errors', () => {
    const providerError = 'Connection error. Failed to fetch'
    const nonTerminal = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: unknown }
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(nonTerminal.error).toBeUndefined()
    expect(terminalError.error).toEqual({
      message: providerError,
      errorType: 'network_error',
    })
  })

  test('classifies a malformed upstream JSON response as service_error', () => {
    const errorMessage = 'Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'service_error' })
  })

  test('keeps non-network terminal Pi errors as provider_error', () => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded',
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: '529 overloaded', errorType: 'provider_error' })
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
  ])('classifies terminal Pi transport error "%s" as network_error', (errorMessage) => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'network_error' })
  })

  test('keeps generated text separate from a terminal transport error', () => {
    const body = 'Generated assistant output must not appear inside the error card.'
    const transportError = 'peer closed connection without sending complete message body (incomplete chunked read)'
    const terminalError = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: body }],
      stopReason: 'error',
      errorMessage: transportError,
    } as unknown as AssistantMessage, 'session-1') as SDKAssistantMessage

    expect(getPiAssistantErrorDetails(terminalError)).toEqual({
      detailedMessage: transportError,
      originalError: transportError,
    })
    expect(hasPiAssistantTextContent(terminalError)).toBe(true)
    expect(stripPiAssistantError(terminalError).error).toBeUndefined()
    expect(terminalError.message.content).toEqual([{ type: 'text', text: body }])
    expect(terminalError.error).toEqual({ message: transportError, errorType: 'network_error' })
  })

  test('only reports result errors for terminal Pi failures', () => {
    const providerError = 'stream ended before a terminal response event'
    const partialStop = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }
    const terminalError = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }

    expect(partialStop.subtype).toBe('success')
    expect(partialStop.errors).toBeUndefined()
    expect(terminalError.subtype).toBe('error_during_execution')
    expect(terminalError.errors).toEqual([providerError])
  })
})

interface ResultShape {
  subtype?: string
  terminal_reason?: string
  errors?: string[]
}

const EMPTY_FINAL_ANSWER_ERROR =
  '模型在后续回合返回了空答复，任务未能正常完成。请重试或切换模型。'

function assistantMessage(
  content: Array<Record<string, unknown>>,
  stopReason = 'stop',
): AssistantMessage {
  return { role: 'assistant', content, stopReason } as unknown as AssistantMessage
}

describe('convertResultMessage：延续后的最终空答复', () => {
  test('given 多条 assistant 且末条 content 为空 stop then 映射为 empty_final_answer', () => {
    const result = convertResultMessage([
      assistantMessage([{ type: 'text', text: '先做第一步。' }]),
      assistantMessage([]),
    ], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).toBe('empty_final_answer')
    expect(result.errors).toEqual([EMPTY_FINAL_ANSWER_ERROR])
  })

  test('given 末条只有空白 text 与空 thinking then 同样映射为 empty_final_answer', () => {
    const result = convertResultMessage([
      assistantMessage([{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }]),
      assistantMessage([
        { type: 'text', text: ' \n' },
        { type: 'thinking', thinking: '' },
      ]),
    ], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).toBe('empty_final_answer')
    expect(result.errors).toEqual([EMPTY_FINAL_ANSWER_ERROR])
  })

  test('given 单条首答为空 then 维持 success/completed 交给既有零可见消息保护', () => {
    const result = convertResultMessage([assistantMessage([])], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('success')
    expect(result.terminal_reason).toBe('completed')
    expect(result.errors).toBeUndefined()
  })

  test.each([
    ['非空白正文', { type: 'text', text: '完成了。' }],
    ['非空白 thinking', { type: 'thinking', thinking: '考虑下一步。' }],
    ['toolCall', { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'a.ts' } }],
  ])('given 多条 assistant 且末条有%s then 维持正常成功', (_label, block) => {
    const result = convertResultMessage([
      assistantMessage([{ type: 'text', text: '先做第一步。' }]),
      assistantMessage([block]),
    ], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('success')
    expect(result.terminal_reason).toBe('completed')
    expect(result.errors).toBeUndefined()
  })

  test('given 末条为空但 stopReason 是 length then 仍是 max_tokens', () => {
    const result = convertResultMessage([
      assistantMessage([{ type: 'text', text: '先做第一步。' }]),
      assistantMessage([], 'length'),
    ], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('max_tokens')
    expect(result.terminal_reason).toBe('max_tokens')
    expect(result.errors).toBeUndefined()
  })

  test('given runtime guard override 与空答复同时存在 then override 全字段优先', () => {
    const result = convertResultMessage([
      assistantMessage([{ type: 'text', text: '先做第一步。' }]),
      assistantMessage([]),
    ], 'session-1', {
      subtype: 'error_max_turns',
      terminalReason: 'max_turns',
      errors: ['已达到 Agent 最大轮次限制（3），已停止后续 prompt、工具调用与排队消息。'],
    }) as unknown as ResultShape

    expect(result.subtype).toBe('error_max_turns')
    expect(result.terminal_reason).toBe('max_turns')
    expect(result.errors).toEqual([
      '已达到 Agent 最大轮次限制（3），已停止后续 prompt、工具调用与排队消息。',
    ])
  })

  test('given 末条是 provider error then 错误信息优先于空答复判定', () => {
    const providerError = 'stream ended before a terminal response event'
    const last = assistantMessage([], 'error')
    last.errorMessage = providerError
    const result = convertResultMessage([
      assistantMessage([{ type: 'text', text: '先做第一步。' }]),
      last,
    ], 'session-1') as unknown as ResultShape

    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).toBe('completed')
    expect(result.errors).toEqual([providerError])
  })
})
