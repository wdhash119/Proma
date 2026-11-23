import { describe, expect, test } from 'bun:test'
import { normalizeLiveCompactSettings } from './settings-service'

/**
 * Live Compact 设置的读取侧归一化边界。
 *
 * 这个函数同时是“新字段被保留”的唯一保证：它没返回的字段会在
 * “读取 → 保存”一来一回里被默默丢掉。所有用例都要求**不抛异常**，
 * 非法输入只回落到对应的默认值。
 */

const DEFAULT_RATIOS = { trigger: 0.5, keepRound: 0.35, urgent: 0.75, bigGate: 0.9 }
const DEFAULT_ABSOLUTE = {
  triggerTokens: 20_000,
  keepRoundTokens: 32_000,
  urgentTokens: 48_000,
  bigGateTokens: 650_000,
}

describe('Live Compact 设置归一化：旧配置回落', () => {
  test('Given 旧 settings.json 只有 enabled=true When 归一化 Then 新字段全部回落缺省且保护为开', () => {
    const settings = normalizeLiveCompactSettings({ enabled: true })
    expect(settings.enabled).toBe(true)
    expect(settings.protectCurrentTurn).toBe(true)
    expect(settings.lineMode).toBe('ratio')
    expect(settings.ratios).toEqual(DEFAULT_RATIOS)
    expect(settings.absolute).toEqual(DEFAULT_ABSOLUTE)
  })

  test('Given 空对象或非对象 When 归一化 Then 关闭且新字段仍回落缺省', () => {
    for (const input of [{}, undefined, null, 'live-compact', 42, true]) {
      const settings = normalizeLiveCompactSettings(input)
      expect(settings.enabled).toBe(false)
      expect(settings.protectCurrentTurn).toBe(true)
      expect(settings.lineMode).toBe('ratio')
      expect(settings.ratios).toEqual(DEFAULT_RATIOS)
      expect(settings.absolute).toEqual(DEFAULT_ABSOLUTE)
    }
  })

  test('Given enabled 为非布尔真值 When 归一化 Then 仍然关闭（只有显式 true 才开）', () => {
    expect(normalizeLiveCompactSettings({ enabled: 'true' }).enabled).toBe(false)
    expect(normalizeLiveCompactSettings({ enabled: 1 }).enabled).toBe(false)
  })
})

describe('Live Compact 设置归一化：当前轮保护开关', () => {
  test('Given 显式 protectCurrentTurn=false When 归一化 Then 关闭保护', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, protectCurrentTurn: false }).protectCurrentTurn).toBe(false)
  })

  test('Given 显式 true 或非法值 When 归一化 Then 保护保持开启', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, protectCurrentTurn: true }).protectCurrentTurn).toBe(true)
    // 手写配置里的字符串 'false' 不能意外关掉保护。
    expect(normalizeLiveCompactSettings({ enabled: true, protectCurrentTurn: 'false' }).protectCurrentTurn).toBe(true)
    expect(normalizeLiveCompactSettings({ enabled: true, protectCurrentTurn: 0 }).protectCurrentTurn).toBe(true)
  })
})

describe('Live Compact 设置归一化：lineMode', () => {
  test('Given lineMode=absolute When 归一化 Then 保留绝对值模式', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, lineMode: 'absolute' }).lineMode).toBe('absolute')
  })

  test('Given 非法 lineMode When 归一化 Then 回落 ratio', () => {
    for (const lineMode of ['ABSOLUTE', 'ratio ', 'tokens', 1, null]) {
      expect(normalizeLiveCompactSettings({ enabled: true, lineMode }).lineMode).toBe('ratio')
    }
  })
})

describe('Live Compact 设置归一化：比例组', () => {
  test('Given 合法比例组 When 归一化 Then 原样保留', () => {
    const ratios = { trigger: 0.6, keepRound: 0.4, urgent: 0.8, bigGate: 0.95 }
    expect(normalizeLiveCompactSettings({ enabled: true, ratios }).ratios).toEqual(ratios)
  })

  test('Given 比例超界 When 归一化 Then 逐字段 clamp 到 0.01..0.99', () => {
    const ratios = normalizeLiveCompactSettings({
      enabled: true,
      ratios: { trigger: 0.5, keepRound: 0, urgent: 0.75, bigGate: 5 },
    }).ratios
    // 夹取后顺序仍然成立，所以保留夹取结果而不是回落缺省。
    expect(ratios).toEqual({ trigger: 0.5, keepRound: 0.01, urgent: 0.75, bigGate: 0.99 })
  })

  test('Given 组内顺序非法（保留线高于起切线）When 归一化 Then 整组回落缺省', () => {
    const settings = normalizeLiveCompactSettings({
      enabled: true,
      ratios: { trigger: 0.5, keepRound: 0.6, urgent: 0.75, bigGate: 0.9 },
    })
    expect(settings.ratios).toEqual(DEFAULT_RATIOS)
  })

  test('Given 组内触发线不低于紧急线 When 归一化 Then 整组回落缺省', () => {
    expect(normalizeLiveCompactSettings({
      enabled: true,
      ratios: { trigger: 0.75, keepRound: 0.35, urgent: 0.75, bigGate: 0.9 },
    }).ratios).toEqual(DEFAULT_RATIOS)
  })

  test('Given 组内缺字段或非数值 When 归一化 Then 整组回落缺省', () => {
    expect(normalizeLiveCompactSettings({
      enabled: true,
      ratios: { trigger: 0.5, keepRound: 0.35, urgent: 0.75 },
    }).ratios).toEqual(DEFAULT_RATIOS)
    expect(normalizeLiveCompactSettings({
      enabled: true,
      ratios: { trigger: 0.5, keepRound: '0.35', urgent: 0.75, bigGate: 0.9 },
    }).ratios).toEqual(DEFAULT_RATIOS)
  })
})

describe('Live Compact 设置归一化：绝对值组', () => {
  test('Given 上游 Origin 顺序（保留线 32000 高于起切线 20000）When 归一化 Then 原样保留', () => {
    const absolute = {
      triggerTokens: 20_000,
      keepRoundTokens: 32_000,
      urgentTokens: 48_000,
      bigGateTokens: 650_000,
    }
    expect(normalizeLiveCompactSettings({ enabled: true, absolute }).absolute).toEqual(absolute)
  })

  test('Given 绝对值超界 When 归一化 Then 逐字段 clamp 到 1..10_000_000', () => {
    const absolute = normalizeLiveCompactSettings({
      enabled: true,
      absolute: {
        triggerTokens: 0,
        keepRoundTokens: -5,
        urgentTokens: 48_000,
        bigGateTokens: 20_000_000,
      },
    }).absolute
    // 只校验触发 < 紧急 < 停手：夹取后 1 < 48000 < 10000000 成立。
    expect(absolute).toEqual({
      triggerTokens: 1,
      keepRoundTokens: 1,
      urgentTokens: 48_000,
      bigGateTokens: 10_000_000,
    })
  })

  test('Given 三段顺序非法 When 归一化 Then 整组回落上游 Origin 默认', () => {
    expect(normalizeLiveCompactSettings({
      enabled: true,
      absolute: {
        triggerTokens: 60_000,
        keepRoundTokens: 32_000,
        urgentTokens: 48_000,
        bigGateTokens: 650_000,
      },
    }).absolute).toEqual(DEFAULT_ABSOLUTE)
    expect(normalizeLiveCompactSettings({
      enabled: true,
      absolute: {
        triggerTokens: 20_000,
        keepRoundTokens: 32_000,
        urgentTokens: 700_000,
        bigGateTokens: 650_000,
      },
    }).absolute).toEqual(DEFAULT_ABSOLUTE)
  })

  test('Given 组内缺字段 When 归一化 Then 整组回落默认', () => {
    expect(normalizeLiveCompactSettings({
      enabled: true,
      absolute: { triggerTokens: 20_000, urgentTokens: 48_000, bigGateTokens: 650_000 },
    }).absolute).toEqual(DEFAULT_ABSOLUTE)
  })
})
