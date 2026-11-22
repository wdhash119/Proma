import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS, type ProviderType } from '@proma/shared'
import { supportsChannelPlanQuota } from './channel-plan-quota'

const PAID_PROVIDERS: ProviderType[] = [
  'anthropic',
  'openai',
  'openai-responses',
  'deepseek',
  'google',
  'kimi-api',
  'kimi-coding',
  'zhipu',
  'zhipu-coding',
  'zhipu-coding-team',
  'minimax',
  'doubao-api',
  'qwen',
  'qwen-anthropic',
  'qwen-token-plan',
  'qianwen',
  'qianwen-anthropic',
  'qianwen-token-plan',
  'qianwen-token-plan-openai',
  'xiaomi',
  'xiaomi-token-plan',
  'openai-codex',
  'github-copilot',
  'xai',
]

describe('付费与订阅渠道额度入口覆盖', () => {
  test.each(PAID_PROVIDERS)('Given 内置付费渠道 %s When 检查额度入口 Then 显示独立额度状态', (provider) => {
    expect(supportsChannelPlanQuota({ provider, baseUrl: PROVIDER_DEFAULT_URLS[provider] })).toBe(true)
  })

  test('Given 无法确认计费方式的自定义/兼容渠道 When 检查 Then 不显示无意义额度徽标', () => {
    expect(supportsChannelPlanQuota({ provider: 'custom', baseUrl: 'http://localhost:8080/v1' })).toBe(false)
    expect(supportsChannelPlanQuota({ provider: 'anthropic-compatible', baseUrl: 'https://gateway.example.com' })).toBe(false)
  })

  test('Given 自定义协议但明确使用 Kimi Coding 地址 When 检查 Then 保留真实额度查询入口', () => {
    expect(supportsChannelPlanQuota({ provider: 'custom', baseUrl: 'https://api.kimi.com/coding/v1' })).toBe(true)
  })
})
