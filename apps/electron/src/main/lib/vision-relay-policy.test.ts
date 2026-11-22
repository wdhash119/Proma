import { describe, expect, test } from 'bun:test'
import {
  isVisionRelayRouteConfigured,
  normalizeVisionRelaySettings,
  shouldForceVisionRelayRead,
  shouldInjectVisionRelayTool,
  type VisionRelaySettings,
} from './vision-relay-policy'

const ROUTE: VisionRelaySettings = { mode: 'auto', channelId: 'channel-1', modelId: 'vision-model' }

describe('视觉助手设置归一化与旧配置迁移', () => {
  test('Given 旧配置 enabled=true When 归一化 Then 迁移为 auto 且不保留 enabled', () => {
    expect(normalizeVisionRelaySettings({ enabled: true, channelId: 'c1', modelId: 'm1' }))
      .toEqual({ mode: 'auto', channelId: 'c1', modelId: 'm1' })
  })

  test('Given 旧配置 enabled=false When 归一化 Then 迁移为 off 但保留已选路由', () => {
    expect(normalizeVisionRelaySettings({ enabled: false, channelId: 'c1', modelId: 'm1' }))
      .toEqual({ mode: 'off', channelId: 'c1', modelId: 'm1' })
  })

  test('Given 完全缺失设置 When 归一化 Then 返回 off 且没有路由', () => {
    for (const input of [undefined, null, {}, 'invalid', 42]) {
      expect(normalizeVisionRelaySettings(input)).toEqual({ mode: 'off' })
    }
  })

  test('Given 有效 mode 与遗留 enabled 冲突 When 归一化 Then mode 优先', () => {
    expect(normalizeVisionRelaySettings({ mode: 'force', enabled: false }).mode).toBe('force')
    expect(normalizeVisionRelaySettings({ mode: 'off', enabled: true }).mode).toBe('off')
  })

  test('Given 非法 mode When 归一化 Then 按旧字段迁移而不是原样透传', () => {
    expect(normalizeVisionRelaySettings({ mode: 'always' }).mode).toBe('off')
    expect(normalizeVisionRelaySettings({ mode: 'always', enabled: true }).mode).toBe('auto')
    expect(normalizeVisionRelaySettings({ mode: 123, enabled: false }).mode).toBe('off')
  })

  test('Given 空字符串或非字符串 ID When 归一化 Then 丢弃该字段', () => {
    expect(normalizeVisionRelaySettings({ mode: 'auto', channelId: '   ', modelId: null }))
      .toEqual({ mode: 'auto' })
    expect(normalizeVisionRelaySettings({ mode: 'auto', channelId: 7, modelId: ' m1 ' }))
      .toEqual({ mode: 'auto', modelId: 'm1' })
  })

  test('Given 渠道与模型齐全 When 检查路由 Then 仅两者都非空才视为已配置', () => {
    expect(isVisionRelayRouteConfigured(ROUTE)).toBe(true)
    expect(isVisionRelayRouteConfigured({ mode: 'auto', channelId: 'c1' })).toBe(false)
    expect(isVisionRelayRouteConfigured({ mode: 'auto', modelId: 'm1' })).toBe(false)
    expect(isVisionRelayRouteConfigured({ mode: 'auto', channelId: ' ', modelId: 'm1' })).toBe(false)
    expect(isVisionRelayRouteConfigured(undefined)).toBe(false)
  })
})

describe('视觉助手注入策略', () => {
  test('Given off 挡位 When 任意模型能力与来源 Then 既不注入也不接管', () => {
    const settings: VisionRelaySettings = { mode: 'off', channelId: 'c1', modelId: 'm1' }
    for (const imageInput of ['supported', 'unsupported', 'unknown'] as const) {
      expect(shouldInjectVisionRelayTool({ settings, imageInput, triggeredBy: 'user' })).toBe(false)
      expect(shouldInjectVisionRelayTool({ settings, imageInput, triggeredBy: 'external' })).toBe(false)
    }
    expect(shouldForceVisionRelayRead({ settings, triggeredBy: 'user' })).toBe(false)
  })

  test('Given auto 挡位 When 当前模型已支持图片 Then 不注入也不接管', () => {
    expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'supported', triggeredBy: 'user' })).toBe(false)
    expect(shouldForceVisionRelayRead({ settings: ROUTE, triggeredBy: 'user' })).toBe(false)
  })

  test('Given auto 挡位 When 当前模型不支持或未确认图片能力 Then 注入但不接管 Read', () => {
    expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'unsupported', triggeredBy: 'user' })).toBe(true)
    expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'unknown', triggeredBy: 'user' })).toBe(true)
    expect(shouldForceVisionRelayRead({ settings: ROUTE, triggeredBy: 'user' })).toBe(false)
  })

  test('Given force 挡位 When 任意模型能力 Then 注入并接管 Read', () => {
    const settings: VisionRelaySettings = { ...ROUTE, mode: 'force' }
    for (const imageInput of ['supported', 'unsupported', 'unknown'] as const) {
      expect(shouldInjectVisionRelayTool({ settings, imageInput, triggeredBy: 'user' })).toBe(true)
    }
    expect(shouldForceVisionRelayRead({ settings, triggeredBy: 'user' })).toBe(true)
    expect(shouldForceVisionRelayRead({ settings, triggeredBy: 'external' })).toBe(true)
  })

  test('Given 开启挡位但路由不完整 When 判定 Then 均不生效', () => {
    for (const mode of ['auto', 'force'] as const) {
      const missingChannel: VisionRelaySettings = { mode, modelId: 'm1' }
      const missingModel: VisionRelaySettings = { mode, channelId: 'c1' }
      expect(shouldInjectVisionRelayTool({ settings: missingChannel, imageInput: 'unsupported' })).toBe(false)
      expect(shouldInjectVisionRelayTool({ settings: missingModel, imageInput: 'unknown' })).toBe(false)
      expect(shouldForceVisionRelayRead({ settings: missingChannel })).toBe(false)
      expect(shouldForceVisionRelayRead({ settings: missingModel })).toBe(false)
    }
  })

  test('Given 无人值守来源 When 判定 Then automation 与 delegation 都不生效', () => {
    const forceSettings: VisionRelaySettings = { ...ROUTE, mode: 'force' }
    for (const triggeredBy of ['automation', 'delegation'] as const) {
      expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'unsupported', triggeredBy })).toBe(false)
      expect(shouldInjectVisionRelayTool({ settings: forceSettings, imageInput: 'supported', triggeredBy })).toBe(false)
      expect(shouldForceVisionRelayRead({ settings: forceSettings, triggeredBy })).toBe(false)
    }
  })

  test('Given 用户或外部桥接来源 When 判定 Then 保持可用', () => {
    const forceSettings: VisionRelaySettings = { ...ROUTE, mode: 'force' }
    for (const triggeredBy of ['user', 'external'] as const) {
      expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'unsupported', triggeredBy })).toBe(true)
      expect(shouldForceVisionRelayRead({ settings: forceSettings, triggeredBy })).toBe(true)
    }
  })

  test('Given 未提供来源 When 判定 Then 按前台会话处理', () => {
    expect(shouldInjectVisionRelayTool({ settings: ROUTE, imageInput: 'unknown' })).toBe(true)
    expect(shouldForceVisionRelayRead({ settings: { ...ROUTE, mode: 'force' } })).toBe(true)
  })
})
