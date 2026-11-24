import { describe, expect, test } from 'bun:test'
import { mergeLiveCompactSettings, normalizeLiveCompactSettings } from './settings-service'

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
    expect(settings.showEvents).toBe(true)
    expect(settings.lineMode).toBe('ratio')
    expect(settings.ratios).toEqual(DEFAULT_RATIOS)
    expect(settings.absolute).toEqual(DEFAULT_ABSOLUTE)
  })

  test('Given 空对象或非对象 When 归一化 Then 关闭且新字段仍回落缺省', () => {
    for (const input of [{}, undefined, null, 'live-compact', 42, true]) {
      const settings = normalizeLiveCompactSettings(input)
      expect(settings.enabled).toBe(false)
      expect(settings.protectCurrentTurn).toBe(true)
      expect(settings.showEvents).toBe(true)
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

describe('Live Compact 设置归一化：显示压缩事件开关', () => {
  test('Given 缺省 When 归一化 Then 显示开启（切割通知与原文召回行都显示）', () => {
    expect(normalizeLiveCompactSettings({ enabled: true }).showEvents).toBe(true)
    expect(normalizeLiveCompactSettings({}).showEvents).toBe(true)
  })

  test('Given 显式 showEvents=false When 归一化 Then 隐藏', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, showEvents: false }).showEvents).toBe(false)
    // 与主闸无关：纯渲染层开关，主闸关闭时仍可独立配置。
    expect(normalizeLiveCompactSettings({ enabled: false, showEvents: false }).showEvents).toBe(false)
  })

  test('Given 显式 true 或非法值 When 归一化 Then 显示保持开启', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, showEvents: true }).showEvents).toBe(true)
    // 手写配置里的字符串 'false' / 0 不能意外关掉显示。
    expect(normalizeLiveCompactSettings({ enabled: true, showEvents: 'false' }).showEvents).toBe(true)
    expect(normalizeLiveCompactSettings({ enabled: true, showEvents: 0 }).showEvents).toBe(true)
  })
})

describe('Live Compact 设置归一化：lineMode', () => {
  test('Given lineMode=absolute When 归一化 Then 保留绝对值模式', () => {
    expect(normalizeLiveCompactSettings({ enabled: true, lineMode: 'absolute' }).lineMode).toBe('absolute')
  })

  test('Given lineMode=origin When 归一化 Then 保留上游 Origin 只读档', () => {
    const settings = normalizeLiveCompactSettings({ enabled: true, lineMode: 'origin' })
    expect(settings.lineMode).toBe('origin')
    // origin 不吞掉自定义组：切回自定义时还要沿用用户上次保存的四条线。
    expect(settings.ratios).toEqual(DEFAULT_RATIOS)
    expect(settings.absolute).toEqual(DEFAULT_ABSOLUTE)
  })

  test('Given 非法 lineMode When 归一化 Then 回落 ratio', () => {
    for (const lineMode of ['ABSOLUTE', 'ORIGIN', 'origin ', 'tokens', 1, null]) {
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

describe('Live Compact 设置写入：补丁合并保留磁盘现值', () => {
  test('Given 磁盘主闸已开 When 补丁只改保护开关 Then enabled 保留磁盘 true 而不是页面旧值', () => {
    // 另一窗口在页面加载后把主闸改成 true，本窗口只改保护开关：省略 enabled 不得把它覆盖回 false。
    const onDisk = normalizeLiveCompactSettings({ enabled: true })
    const merged = mergeLiveCompactSettings(onDisk, { protectCurrentTurn: false })

    expect(merged.enabled).toBe(true)
    expect(merged.protectCurrentTurn).toBe(false)
  })

  test('Given 磁盘四条线已保存 When 补丁只改四条线 Then 未提及字段（保护、主闸）原样保留', () => {
    const onDisk = normalizeLiveCompactSettings({
      enabled: true,
      protectCurrentTurn: false,
      lineMode: 'absolute',
      absolute: {
        triggerTokens: 20_000,
        keepRoundTokens: 32_000,
        urgentTokens: 48_000,
        bigGateTokens: 650_000,
      },
    })
    const merged = mergeLiveCompactSettings(onDisk, {
      lineMode: 'ratio',
      ratios: { trigger: 0.6, keepRound: 0.4, urgent: 0.8, bigGate: 0.95 },
    })

    expect(merged.enabled).toBe(true)
    expect(merged.protectCurrentTurn).toBe(false)
    expect(merged.lineMode).toBe('ratio')
    expect(merged.ratios).toEqual({ trigger: 0.6, keepRound: 0.4, urgent: 0.8, bigGate: 0.95 })
    // 未提到的绝对值组不能被补丁抹掉。
    expect(merged.absolute).toEqual(onDisk.absolute)
  })

  test('Given 磁盘是自定义档 When 补丁只切到 origin Then 四条线原样保留', () => {
    const onDisk = normalizeLiveCompactSettings({
      enabled: true,
      lineMode: 'ratio',
      ratios: { trigger: 0.6, keepRound: 0.4, urgent: 0.8, bigGate: 0.95 },
    })
    const merged = mergeLiveCompactSettings(onDisk, { lineMode: 'origin' })

    expect(merged.lineMode).toBe('origin')
    expect(merged.ratios).toEqual({ trigger: 0.6, keepRound: 0.4, urgent: 0.8, bigGate: 0.95 })
  })

  test('Given 空补丁或无补丁 When 合并 Then 结果等于读取侧归一化现值', () => {
    const onDisk = normalizeLiveCompactSettings({ enabled: true, lineMode: 'absolute' })

    expect(mergeLiveCompactSettings(onDisk, {})).toEqual(onDisk)
    expect(mergeLiveCompactSettings(onDisk, undefined)).toEqual(onDisk)
    expect(mergeLiveCompactSettings(undefined, { protectCurrentTurn: false })).toEqual({
      enabled: false,
      protectCurrentTurn: false,
      showEvents: true,
      lineMode: 'ratio',
      ratios: DEFAULT_RATIOS,
      absolute: DEFAULT_ABSOLUTE,
    })
  })
})
