import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from './channel'
import { inferReasoningTransport } from './reasoning-profile'
import { inferContextWindow, ONE_MILLION_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW } from '../utils/context-window'

describe('千问AI平台渠道定义', () => {
  test('Given 四个新 provider 类型 When 读取默认地址 Then 指向官方对应协议端点', () => {
    expect(PROVIDER_DEFAULT_URLS.qianwen).toBe('https://maas.qianwenaiapi.com/compatible-mode/v1')
    expect(PROVIDER_DEFAULT_URLS['qianwen-anthropic']).toBe('https://maas.qianwenaiapi.com/apps/anthropic')
    expect(PROVIDER_DEFAULT_URLS['qianwen-token-plan']).toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic')
    expect(PROVIDER_DEFAULT_URLS['qianwen-token-plan-openai']).toBe('https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1')
  })

  test('Given 四个新 provider 类型 When 读取显示名称 Then 均包含平台名与协议标识', () => {
    expect(PROVIDER_LABELS.qianwen).toContain('千问AI平台')
    expect(PROVIDER_LABELS['qianwen-anthropic']).toContain('Anthropic')
    expect(PROVIDER_LABELS['qianwen-token-plan']).toContain('Token Plan')
    expect(PROVIDER_LABELS['qianwen-token-plan-openai']).toContain('OpenAI')
  })

  test('Given OpenAI 兼容渠道 When 推断 reasoning transport Then 归类为 openai-completions', () => {
    expect(inferReasoningTransport('qianwen')).toBe('openai-completions')
    expect(inferReasoningTransport('qianwen-token-plan-openai')).toBe('openai-completions')
  })

  test('Given Anthropic 兼容渠道 When 推断 reasoning transport Then 归类为 anthropic-messages', () => {
    expect(inferReasoningTransport('qianwen-anthropic')).toBe('anthropic-messages')
    expect(inferReasoningTransport('qianwen-token-plan')).toBe('anthropic-messages')
  })

  test('Given qwen4-max 系列模型 When 推断上下文窗口 Then 为 1M（含别名 qwen4.0-max-preview）', () => {
    expect(inferContextWindow('qwen4-max')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('qwen4-max-preview')).toBe(ONE_MILLION_CONTEXT_WINDOW)
    expect(inferContextWindow('qwen4.0-max-preview')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 既有 qwen3.8 模型 When 推断上下文窗口 Then 保持 1M（回归）', () => {
    expect(inferContextWindow('qwen3.8-max')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 平台路由模型 auto When 推断上下文窗口 Then 使用默认窗口', () => {
    expect(inferContextWindow('auto')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})