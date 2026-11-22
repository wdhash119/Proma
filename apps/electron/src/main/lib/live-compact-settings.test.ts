import { describe, expect, test } from 'bun:test'
import {
  buildLiveCompactQueryInput,
  resolveLiveCompactContextWindow,
  resolveLiveCompactEnabled,
} from './live-compact-settings'

const enabledSettings = { liveCompact: { enabled: true } }
const disabledSettings = { liveCompact: { enabled: false } }
const missingSettings = {}

describe('Live Compact 生效开关解析（全局主闸）', () => {
  test('关键安全用例：Given 全局关闭 When 会话 meta 写 true Then 仍然硬停', () => {
    expect(resolveLiveCompactEnabled({ liveCompact: true }, disabledSettings)).toBe(false)
    // 历史会话遗留的 meta=true 不能在全局关闭后继续切段。
    expect(resolveLiveCompactEnabled({ liveCompact: true }, missingSettings)).toBe(false)
    expect(resolveLiveCompactEnabled({ liveCompact: true }, undefined)).toBe(false)
  })

  test('Given 全局开启 When 会话显式开启或未设置 Then 都生效（继承 = 开）', () => {
    expect(resolveLiveCompactEnabled({ liveCompact: true }, enabledSettings)).toBe(true)
    expect(resolveLiveCompactEnabled({}, enabledSettings)).toBe(true)
    expect(resolveLiveCompactEnabled(undefined, enabledSettings)).toBe(true)
    expect(resolveLiveCompactEnabled(null, enabledSettings)).toBe(true)
  })

  test('Given 全局开启 When 会话显式关闭 Then 只关本会话', () => {
    expect(resolveLiveCompactEnabled({ liveCompact: false }, enabledSettings)).toBe(false)
  })

  test('Given 全局关闭或缺失 When 会话任意取值 Then 一律不生效（含会话 false）', () => {
    for (const meta of [{ liveCompact: false }, {}, undefined, null]) {
      expect(resolveLiveCompactEnabled(meta, disabledSettings)).toBe(false)
      expect(resolveLiveCompactEnabled(meta, missingSettings)).toBe(false)
      expect(resolveLiveCompactEnabled(meta, undefined)).toBe(false)
      // 手写配置里出现非布尔值也不能意外开启。
      expect(resolveLiveCompactEnabled(meta, { liveCompact: { enabled: 'true' } as never })).toBe(false)
    }
  })

  test('Given 完整真值表 When 枚举 3×4 组合 Then 只有“全局开启且会话非 false”生效', () => {
    const metas = [
      { label: 'meta=true', value: { liveCompact: true } },
      { label: 'meta=false', value: { liveCompact: false } },
      { label: 'meta=undefined', value: {} },
    ] as const
    const settingsCases = [
      { label: 'global=true', value: enabledSettings },
      { label: 'global=false', value: disabledSettings },
      { label: 'global=缺省', value: missingSettings },
      { label: 'global缺失', value: undefined },
    ] as const

    for (const meta of metas) {
      for (const setting of settingsCases) {
        const expected = setting.label === 'global=true' && meta.label !== 'meta=false'
        expect(
          resolveLiveCompactEnabled(meta.value, setting.value),
          `${meta.label} × ${setting.label}`,
        ).toBe(expected)
      }
    }
  })
})

describe('Live Compact 上下文窗口来源', () => {
  test('Given 渠道手动覆盖窗口 When 解析 Then 覆盖优先于模型名推断', () => {
    expect(resolveLiveCompactContextWindow({
      modelId: 'claude-sonnet-4-6',
      modelCapabilities: { contextWindow: 128000 },
    })).toBe(128000)
  })

  test('Given 无手动覆盖 When 已知 1M 家族模型 Then 按 shared 推断 1M', () => {
    expect(resolveLiveCompactContextWindow({ modelId: 'claude-sonnet-4-6' })).toBe(1_000_000)
  })

  test('Given 无手动覆盖且模型未知 Then 保守回落 200K', () => {
    expect(resolveLiveCompactContextWindow({ modelId: 'some-unknown-model' })).toBe(200_000)
    expect(resolveLiveCompactContextWindow({})).toBe(200_000)
  })

  test('Given 手动覆盖不是正数 When 解析 Then 忽略该覆盖', () => {
    expect(resolveLiveCompactContextWindow({
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: -1 },
    })).toBe(200_000)
  })
})

describe('Live Compact 查询输入组装', () => {
  test('Given 全局关闭且会话未设置 When 组装 Then 返回 undefined（零行为变化）', () => {
    expect(buildLiveCompactQueryInput({
      meta: {},
      settings: disabledSettings,
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })).toBeUndefined()
    expect(buildLiveCompactQueryInput({
      meta: undefined,
      settings: missingSettings,
      configDir: '/tmp/proma',
    })).toBeUndefined()
  })

  test('关键安全用例：Given 全局关闭 When 会话 meta 写 true Then 不下发任何参数', () => {
    // 全局主闸关闭时不能产出 thresholds/env，否则历史 meta=true 的会话会继续切段。
    expect(buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: disabledSettings,
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })).toBeUndefined()
  })

  test('Given 会话显式关闭 When 全局开启 Then 仍返回 undefined', () => {
    expect(buildLiveCompactQueryInput({
      meta: { liveCompact: false },
      settings: enabledSettings,
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })).toBeUndefined()
  })

  test('Given 生效 When 组装 Then 阈值按窗口换算且 env 记录与阈值同源', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: enabledSettings,
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 200_000 },
      configDir: '/tmp/proma',
    })
    expect(input).toBeDefined()
    expect(input?.enabled).toBe(true)
    expect(input?.configDir).toBe('/tmp/proma')
    // 200K 窗口：触发 100K / 保留轮 70K。
    expect(input?.thresholds.minPressureTokens).toBe(100_000)
    expect(input?.thresholds.keepRoundTokens).toBe(70_000)
    // env 记录必须就是同一批已求值结果，而不是第二次换算。
    expect(input?.thresholds.env.SPINE_MIN_TOKENS).toBe('100000')
    expect(input?.thresholds.env.SPINE_KEEP_ROUND_TOKENS).toBe('70000')
    // 只包含算法层真正读取的键：胶层自用阈值（紧急线/停手线）不发 env。
    expect(input?.thresholds.env.SPINE_URGENT_TOKENS).toBeUndefined()
    expect(input?.thresholds.env.SPINE_BIG_GATE).toBeUndefined()
  })

  test('Given 组装结果 When 结构化克隆 Then 可跨 MessagePort 传递', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: enabledSettings,
      modelId: 'claude-sonnet-4-6',
      configDir: '/tmp/proma',
    })
    if (!input) throw new Error('应当已启用 Live Compact')
    const cloned = structuredClone(input)
    expect(cloned).toEqual(input)
  })
})
