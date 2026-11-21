import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, SystemMessage, UserMessage } from '@earendil-works/pi-ai'
import { injectPersonaPrimerTurns, type PersonaPrimerModelRef } from './pi-persona-primer'

const modelRef: PersonaPrimerModelRef = {
  api: 'anthropic-messages',
  provider: 'proma-test',
  modelId: 'test-model',
}

function systemMessage(content: string): SystemMessage {
  return { role: 'system', content, timestamp: 0 }
}

function userMessage(content: string): UserMessage {
  return { role: 'user', content, timestamp: 1 }
}

function assistantMessage(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    api: 'anthropic-messages',
    provider: 'proma-test',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 2,
  }
}

describe('人设示范轮注入', () => {
  test('Given 无示范轮 When 注入 Then 原样返回同一数组', () => {
    const messages: AgentMessage[] = [systemMessage('sys'), userMessage('hi')]
    expect(injectPersonaPrimerTurns(messages, undefined, modelRef)).toBe(messages)
    expect(injectPersonaPrimerTurns(messages, [], modelRef)).toBe(messages)
  })

  test('Given 系统消息与真实历史 When 注入示范轮 Then 插在系统之后历史之前', () => {
    const messages: AgentMessage[] = [systemMessage('sys'), userMessage('真实问题'), assistantMessage('真实回答')]
    const result = injectPersonaPrimerTurns(messages, [
      { role: 'user', content: '示范问' },
      { role: 'assistant', content: '示范答' },
    ], modelRef)

    expect(result.length).toBe(5)
    expect(result[0]?.role).toBe('system')
    expect(result[1]?.role).toBe('user')
    expect(result[2]?.role).toBe('assistant')
    expect(result[3]?.role).toBe('user')
    expect((result[1] as UserMessage).content).toBe('示范问')
    const primerAssistant = result[2] as AssistantMessage
    expect(primerAssistant.content).toEqual([{ type: 'text', text: '示范答' }])
    expect(primerAssistant.usage.totalTokens).toBe(0)
    expect(primerAssistant.stopReason).toBe('stop')
    expect(primerAssistant.model).toBe('test-model')
    // 原始历史不被篡改
    expect((result[3] as UserMessage).content).toBe('真实问题')
  })

  test('Given 无系统消息 When 注入 Then 示范轮置于开头', () => {
    const messages: AgentMessage[] = [userMessage('hi')]
    const result = injectPersonaPrimerTurns(messages, [{ role: 'user', content: '示范' }], modelRef)
    expect(result[0]?.role).toBe('user')
    expect((result[0] as UserMessage).content).toBe('示范')
    expect(result.length).toBe(2)
  })

  test('Given 多次注入 When 每次从原始消息变换 Then 不累积重复示范轮', () => {
    const messages: AgentMessage[] = [systemMessage('sys'), userMessage('hi')]
    const turns = [{ role: 'user' as const, content: '示范' }]
    const first = injectPersonaPrimerTurns(messages, turns, modelRef)
    const second = injectPersonaPrimerTurns(messages, turns, modelRef)
    expect(first.length).toBe(second.length)
    expect(messages.length).toBe(2)
  })
})