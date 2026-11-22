import { describe, expect, test } from 'bun:test'
import { PROMA_DEFAULT_PERMISSION_MODE } from '@proma/shared'
import {
  buildModel,
  resolveModelCapabilitySummary,
  resolvePiImageInputCapability,
  resolvePiReasoningCapability,
  resolvePiVisionRelayRoute,
} from './pi-model-registry'

/** 目录与名称推断都无法识别的模型 ID。 */
const UNKNOWN_MODEL_ID = 'totally-unknown-model-xyz'

describe('模型能力手动覆盖：推理能力', () => {
  test('Given 未识别模型且无覆盖 When 解析推理能力 Then 返回 undefined', async () => {
    expect(await resolvePiReasoningCapability('custom', UNKNOWN_MODEL_ID)).toBeUndefined()
  })

  test('Given 未识别模型但手动启用推理 When 解析 Then 返回 manual 标准档位', async () => {
    const capability = await resolvePiReasoningCapability('custom', UNKNOWN_MODEL_ID, { reasoning: true })
    expect(capability?.source).toBe('manual')
    expect(capability?.levels).toContain('off')
    expect(capability?.levels).toContain('high')
    expect(capability?.defaultLevel).toBe('high')
  })

  test('Given 已识别推理模型但手动禁用 When 解析 Then 覆盖优先返回 undefined', async () => {
    // glm-5.3 在 openai-completions 协议下有专属 profile，默认必然识别。
    const detected = await resolvePiReasoningCapability('custom', 'glm-5.3')
    expect(detected).toBeDefined()
    expect(await resolvePiReasoningCapability('custom', 'glm-5.3', { reasoning: false })).toBeUndefined()
  })
})

describe('模型能力手动覆盖：图片输入与视觉路由', () => {
  test('Given 未识别模型 When 解析图片能力 Then 无覆盖为 unknown，手动覆盖生效', async () => {
    expect(await resolvePiImageInputCapability('custom', UNKNOWN_MODEL_ID)).toBe('unknown')
    expect(await resolvePiImageInputCapability('custom', UNKNOWN_MODEL_ID, { imageInput: true })).toBe('supported')
    expect(await resolvePiImageInputCapability('custom', UNKNOWN_MODEL_ID, { imageInput: false })).toBe('unsupported')
  })

  test('Given 未识别模型手动声明图片输入 When 解析视觉路由 Then 允许路由', async () => {
    expect(await resolvePiVisionRelayRoute('custom', UNKNOWN_MODEL_ID)).toBeUndefined()
    expect(await resolvePiVisionRelayRoute('custom', UNKNOWN_MODEL_ID, { imageInput: true }))
      .toEqual({ adapterProvider: 'custom' })
    expect(await resolvePiVisionRelayRoute('custom', UNKNOWN_MODEL_ID, { imageInput: false })).toBeUndefined()
  })

  test('Given 原生视觉模型但手动禁用图片 When 解析 Then 覆盖优先拒绝', async () => {
    expect(await resolvePiImageInputCapability('custom', 'deepseek-v4-flash')).toBe('supported')
    expect(await resolvePiImageInputCapability('custom', 'deepseek-v4-flash', { imageInput: false })).toBe('unsupported')
    expect(await resolvePiVisionRelayRoute('custom', 'deepseek-v4-flash', { imageInput: false })).toBeUndefined()
  })
})

describe('模型能力手动覆盖：自动检测摘要', () => {
  test('Given 未识别模型 When 解析摘要 Then 标记未识别并给出回落默认值', async () => {
    const summary = await resolveModelCapabilitySummary('custom', UNKNOWN_MODEL_ID)
    expect(summary.detected).toBe(false)
    expect(summary.contextWindow).toBe(200_000)
    expect(summary.maxOutputTokens).toBe(64_000)
    expect(summary.imageInput).toBeUndefined()
    expect(summary.reasoning).toBeUndefined()
  })

  test('Given 内置目录模型 When 解析摘要 Then 标记已识别', async () => {
    // gpt-6-astra 由仓库内 CODEX_MODEL_PATCHES 完整定义，不随外部目录变化。
    const summary = await resolveModelCapabilitySummary('openai-codex', 'gpt-6-astra')
    expect(summary.detected).toBe(true)
    expect(summary.contextWindow).toBeGreaterThan(0)
    expect(summary.maxOutputTokens).toBeGreaterThan(0)
  })
})

describe('模型能力手动覆盖：Pi 模型注册', () => {
  test('Given 未识别模型配置手动覆盖 When 注册 Then 上下文/输出/模态/推理全部生效', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { model } = await buildModel(sdk, {
      sessionId: 'capability-overrides-test',
      prompt: 'hi',
      model: UNKNOWN_MODEL_ID,
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      provider: 'custom',
      permissionMode: PROMA_DEFAULT_PERMISSION_MODE,
      systemPrompt: '',
      piAgentDir: '/tmp/proma-test-agent',
      piSessionDir: '/tmp/proma-test-session',
      modelCapabilities: {
        contextWindow: 123_456,
        maxOutputTokens: 4_321,
        imageInput: false,
        reasoning: false,
      },
    })
    expect(model.contextWindow).toBe(123_456)
    expect(model.maxTokens).toBe(4_321)
    expect(model.input).toEqual(['text'])
    expect(model.reasoning).toBe(false)
  })

  test('Given 未识别模型无覆盖 When 注册 Then 保持保守默认值', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { model } = await buildModel(sdk, {
      sessionId: 'capability-overrides-test-default',
      prompt: 'hi',
      model: UNKNOWN_MODEL_ID,
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      provider: 'custom',
      permissionMode: PROMA_DEFAULT_PERMISSION_MODE,
      systemPrompt: '',
      piAgentDir: '/tmp/proma-test-agent',
      piSessionDir: '/tmp/proma-test-session',
    })
    expect(model.contextWindow).toBe(200_000)
    expect(model.maxTokens).toBe(64_000)
    expect(model.input).toContain('image')
  })

  test('Given 非法覆盖字段 When 注册 Then 丢弃非法值不影响其余字段', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { model } = await buildModel(sdk, {
      sessionId: 'capability-overrides-test-invalid',
      prompt: 'hi',
      model: UNKNOWN_MODEL_ID,
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      provider: 'custom',
      permissionMode: PROMA_DEFAULT_PERMISSION_MODE,
      systemPrompt: '',
      piAgentDir: '/tmp/proma-test-agent',
      piSessionDir: '/tmp/proma-test-session',
      modelCapabilities: { contextWindow: -1, maxOutputTokens: 8_192 },
    })
    expect(model.contextWindow).toBe(200_000)
    expect(model.maxTokens).toBe(8_192)
  })
})