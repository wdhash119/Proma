import { describe, expect, test } from 'bun:test'
import { hasModelCapabilityOverrides, normalizeModelCapabilityOverrides } from './model-capabilities'

describe('模型能力手动覆盖规范化', () => {
  test('Given 完整合法覆盖 When 规范化 Then 原样保留四个字段', () => {
    expect(normalizeModelCapabilityOverrides({
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      imageInput: true,
      reasoning: false,
    })).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      imageInput: true,
      reasoning: false,
    })
  })

  test('Given 部分字段 When 规范化 Then 仅保留有效字段', () => {
    expect(normalizeModelCapabilityOverrides({ contextWindow: 128_000, reasoning: true }))
      .toEqual({ contextWindow: 128_000, reasoning: true })
  })

  test('Given 小数 token 数 When 规范化 Then 向下取整', () => {
    expect(normalizeModelCapabilityOverrides({ contextWindow: 200_000.9 }))
      .toEqual({ contextWindow: 200_000 })
  })

  test('Given 非法 token 数（0/负数/NaN/超上限/字符串） When 规范化 Then 丢弃该字段', () => {
    expect(normalizeModelCapabilityOverrides({
      contextWindow: 0,
      maxOutputTokens: -1,
    })).toBeUndefined()
    expect(normalizeModelCapabilityOverrides({ contextWindow: Number.NaN })).toBeUndefined()
    expect(normalizeModelCapabilityOverrides({ contextWindow: 100_000_001 })).toBeUndefined()
    expect(normalizeModelCapabilityOverrides({ contextWindow: '200000' })).toBeUndefined()
  })

  test('Given 非布尔的能力开关 When 规范化 Then 丢弃该字段', () => {
    expect(normalizeModelCapabilityOverrides({ imageInput: 'yes', reasoning: 1 })).toBeUndefined()
  })

  test('Given 空对象/null/非对象 When 规范化 Then 返回 undefined（跟随自动检测）', () => {
    expect(normalizeModelCapabilityOverrides({})).toBeUndefined()
    expect(normalizeModelCapabilityOverrides(null)).toBeUndefined()
    expect(normalizeModelCapabilityOverrides(undefined)).toBeUndefined()
    expect(normalizeModelCapabilityOverrides('manual')).toBeUndefined()
  })

  test('Given 混合有效与无效字段 When 规范化 Then 仅保留有效部分', () => {
    expect(normalizeModelCapabilityOverrides({
      contextWindow: -5,
      maxOutputTokens: 8192,
      imageInput: false,
      reasoning: 'true',
    })).toEqual({ maxOutputTokens: 8192, imageInput: false })
  })

  test('Given 覆盖存在性判断 When 检查 Then 与规范化结果一致', () => {
    expect(hasModelCapabilityOverrides({ reasoning: false })).toBe(true)
    expect(hasModelCapabilityOverrides({ contextWindow: 0 })).toBe(false)
    expect(hasModelCapabilityOverrides(undefined)).toBe(false)
  })
})