import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@proma/shared'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { setPromaVersion } from './user-agent.ts'

function buildRequest(provider: ProviderType, apiKey = 'test-key', thinkingEnabled?: boolean) {
  const adapter = new AnthropicAdapter(provider)
  const baseUrl = provider === 'xiaomi-token-plan'
    ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
    : provider === 'qwen-token-plan'
      ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages'
      : provider === 'qianwen-anthropic'
        ? 'https://maas.qianwenaiapi.com/apps/anthropic'
        : provider === 'qianwen-token-plan'
          ? 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic'
          : provider === 'zhipu-coding-team'
            ? 'https://open.bigmodel.cn/api/anthropic'
            : 'https://api.xiaomimimo.com/anthropic'

  return adapter.buildStreamRequest({
    baseUrl,
    apiKey,
    modelId: provider === 'qianwen-anthropic' || provider === 'qianwen-token-plan' ? 'qwen3.8-max' : 'mimo-v2.6-pro',
    history: [],
    userMessage: 'ping',
    readImageAttachments: () => [],
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
  })
}

describe('AnthropicAdapter headers', () => {
  test('xiaomi API uses api-key authentication', () => {
    const request = buildRequest('xiaomi')

    expect(request.headers['api-key']).toBe('test-key')
    expect(request.headers.Authorization).toBeUndefined()
    expect(request.headers['User-Agent']).toBeUndefined()
  })

  test('xiaomi token plan keeps bearer authentication with Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('xiaomi-token-plan')

    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('qwen token plan uses the complete Anthropic endpoint with bearer authentication and Proma User-Agent', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest('qwen-token-plan')

    expect(request.url).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('zhipu team plan uses apiKey from JSON for model calls', () => {
    setPromaVersion('9.9.9')

    const request = buildRequest(
      'zhipu-coding-team',
      '{"apiKey":"model-key","organization":"org","project":"proj"}',
    )

    expect(request.headers.Authorization).toBe('Bearer model-key')
    expect(request.headers['User-Agent']).toBe('Proma/9.9.9 (+https://github.com/ErlichLiu/Proma)')
    expect(request.headers['api-key']).toBeUndefined()
  })

  test('Given qianwen API Anthropic channel When building request Then resolves versioned messages endpoint with bearer auth', () => {
    const request = buildRequest('qianwen-anthropic')

    expect(request.url).toBe('https://maas.qianwenaiapi.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('Given qianwen API Anthropic channel When thinking enabled Then sends manual thinking budget', () => {
    const request = buildRequest('qianwen-anthropic', 'test-key', true)
    const body = JSON.parse(request.body) as { thinking?: { type: string; budget_tokens?: number } }

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
  })

  test('Given qianwen Token Plan channel When building request Then resolves versioned messages endpoint with bearer auth', () => {
    const request = buildRequest('qianwen-token-plan')

    expect(request.url).toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages')
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.headers['x-api-key']).toBeUndefined()
  })

  test('Given qianwen Token Plan channel When thinking enabled Then omits thinking field for endpoint compatibility', () => {
    const request = buildRequest('qianwen-token-plan', 'test-key', true)
    const body = JSON.parse(request.body) as { thinking?: unknown }

    expect(body.thinking).toBeUndefined()
  })

  test('Given qianwen Token Plan channel When building title request Then omits thinking disabled field', () => {
    const adapter = new AnthropicAdapter('qianwen-token-plan')
    const request = adapter.buildTitleRequest({
      baseUrl: 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic',
      apiKey: 'test-key',
      modelId: 'auto',
      prompt: '生成标题',
    })
    const body = JSON.parse(request.body) as { thinking?: unknown }

    expect(request.url).toBe('https://token-plan.maas.qianwenaiapi.com/apps/anthropic/v1/messages')
    expect(body.thinking).toBeUndefined()
  })
})
