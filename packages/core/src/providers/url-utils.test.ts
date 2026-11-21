import { describe, expect, test } from 'bun:test'
import {
  normalizeAnthropicProviderUrl,
  resolveAnthropicMessagesUrl,
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIModelsUrl,
} from './url-utils.ts'

describe('千问AI平台 URL 解析', () => {
  test('Given API Anthropic 协议根地址 When 解析 messages Then 补齐 /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://maas.qianwenaiapi.com/apps/anthropic', 'qianwen-anthropic'))
      .toBe('https://maas.qianwenaiapi.com/apps/anthropic/v1/messages')
  })

  test('Given Token Plan Anthropic 协议根地址 When 解析 messages Then 补齐 /v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://token-plan.maas.qianwenaiapi.com/apps/anthropic', 'qianwen-token-plan'))
      .toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages')
  })

  test('Given 已填写完整 messages 端点 When 解析 Then 原样保留不重复拼接', () => {
    expect(resolveAnthropicMessagesUrl('https://maas.qianwenaiapi.com/apps/anthropic/v1/messages', 'qianwen-anthropic'))
      .toBe('https://maas.qianwenaiapi.com/apps/anthropic/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages/', 'qianwen-token-plan'))
      .toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages')
  })

  test('Given 协议根地址 When 规范化 Then 仅追加一次 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://maas.qianwenaiapi.com/apps/anthropic', 'qianwen-anthropic'))
      .toBe('https://maas.qianwenaiapi.com/apps/anthropic/v1')
    expect(normalizeAnthropicProviderUrl('https://maas.qianwenaiapi.com/apps/anthropic/v1', 'qianwen-anthropic'))
      .toBe('https://maas.qianwenaiapi.com/apps/anthropic/v1')
  })

  test('Given OpenAI 兼容协议根地址 When 解析 chat/completions 与 models Then 正确拼接', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://maas.qianwenaiapi.com/compatible-mode/v1', 'qianwen'))
      .toBe('https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions')
    expect(resolveOpenAIChatCompletionsUrl('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1', 'qianwen-token-plan-openai'))
      .toBe('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/chat/completions')
    expect(resolveOpenAIModelsUrl('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1'))
      .toBe('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/models')
  })

  test('Given 旧版通义千问 Token Plan 完整端点 When 解析 Then 行为不变（回归）', () => {
    expect(resolveAnthropicMessagesUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages', 'qwen-token-plan'))
      .toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
  })
})