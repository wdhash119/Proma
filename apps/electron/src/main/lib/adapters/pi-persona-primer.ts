/**
 * 人设示范轮（primerTurns）的 Pi 请求上下文注入。
 *
 * 示范轮是注入在系统消息之后、真实历史之前的静态合成 user/assistant 轮，
 * 让模型在上下文中"看到自己已经履约过一次"（few-shot 前缀）。
 * 与 pi-app 的注入语义一致：纯内存变换，不写入会话 artifact；
 * 每次请求重新插入，静态前缀对 KV cache 友好。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai'
import type { PersonaPrimerTurn } from '@proma/shared'

/** 构造示范轮所需的模型标识（取自当前会话注册的 Pi model） */
export interface PersonaPrimerModelRef {
  api: AssistantMessage['api']
  provider: AssistantMessage['provider']
  modelId: string
}

const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * 在系统消息之后插入示范轮。
 *
 * - 无示范轮时原样返回（不产生新数组，避免无谓的上下文拷贝）
 * - 找到首条 system 消息则插在其后；没有 system 消息时插在开头
 * - 合成 assistant 轮使用当前模型标识与零用量，stopReason 为 stop
 */
export function injectPersonaPrimerTurns(
  messages: AgentMessage[],
  primerTurns: PersonaPrimerTurn[] | undefined,
  model: PersonaPrimerModelRef,
): AgentMessage[] {
  if (!primerTurns || primerTurns.length === 0) return messages

  const primerMessages: AgentMessage[] = primerTurns.map((turn): AgentMessage => {
    if (turn.role === 'user') {
      const message: UserMessage = { role: 'user', content: turn.content, timestamp: 0 }
      return message
    }
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: turn.content }],
      api: model.api,
      provider: model.provider,
      model: model.modelId,
      usage: ZERO_USAGE,
      stopReason: 'stop',
      timestamp: 0,
    }
    return message
  })

  const systemIndex = messages.findIndex((message) => message.role === 'system')
  const insertAt = systemIndex === -1 ? 0 : systemIndex + 1
  return [
    ...messages.slice(0, insertAt),
    ...primerMessages,
    ...messages.slice(insertAt),
  ]
}