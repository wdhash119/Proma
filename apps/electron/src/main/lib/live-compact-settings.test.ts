import { describe, expect, test } from 'bun:test'
import {
  buildLiveCompactQueryInput,
  resolveLiveCompactContextWindow,
  resolveLiveCompactEnabled,
  resolveLiveCompactLineOverrides,
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

describe('Live Compact 四条线：比例与绝对值换算', () => {
  test('Given 比例模式缺省（0.5/0.35/0.75/0.9）When 200K 窗口 Then 100000/70000/150000/180000', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true } },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 200_000 },
      configDir: '/tmp/proma',
    })
    expect(input?.thresholds.minPressureTokens).toBe(100_000)
    expect(input?.thresholds.keepRoundTokens).toBe(70_000)
    expect(input?.thresholds.urgentTokens).toBe(150_000)
    expect(input?.thresholds.bigGateTokens).toBe(180_000)
  })

  test('Given 比例模式自定义占比 When 128K 窗口 Then 按窗口乘比例如实换算', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: {
        liveCompact: {
          enabled: true,
          lineMode: 'ratio',
          ratios: { trigger: 0.6, keepRound: 0.45, urgent: 0.8, bigGate: 0.95 },
        },
      },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 128_000 },
      configDir: '/tmp/proma',
    })
    expect(input?.thresholds.minPressureTokens).toBe(76_800)
    expect(input?.thresholds.keepRoundTokens).toBe(57_600)
    expect(input?.thresholds.urgentTokens).toBe(102_400)
    expect(input?.thresholds.bigGateTokens).toBe(121_600)
  })

  test('Given 绝对值模式 When 任意窗口 Then 四条线直传 token 数、不乘窗口', () => {
    const absolute = {
      triggerTokens: 30_000,
      keepRoundTokens: 40_000,
      urgentTokens: 60_000,
      bigGateTokens: 90_000,
    }
    for (const contextWindow of [50_000, 200_000, 1_000_000]) {
      const input = buildLiveCompactQueryInput({
        meta: { liveCompact: true },
        settings: { liveCompact: { enabled: true, lineMode: 'absolute', absolute } },
        modelId: 'some-unknown-model',
        modelCapabilities: { contextWindow },
        configDir: '/tmp/proma',
      })
      expect(input?.thresholds.minPressureTokens).toBe(30_000)
      expect(input?.thresholds.keepRoundTokens).toBe(40_000)
      expect(input?.thresholds.urgentTokens).toBe(60_000)
      expect(input?.thresholds.bigGateTokens).toBe(90_000)
    }
  })

  test('Given 绝对值模式缺省组 When 组装 Then 用上游 Origin 20000/32000/48000/650000', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true, lineMode: 'absolute' } },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 200_000 },
      configDir: '/tmp/proma',
    })
    expect(input?.thresholds.minPressureTokens).toBe(20_000)
    expect(input?.thresholds.keepRoundTokens).toBe(32_000)
    expect(input?.thresholds.urgentTokens).toBe(48_000)
    expect(input?.thresholds.bigGateTokens).toBe(650_000)
  })

  test('Given 比例顺序非法（绕过归一化直接构造）When 组装 Then 沿用“本条不启用 + warn”兜底', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: {
        liveCompact: {
          enabled: true,
          ratios: { trigger: 0.5, keepRound: 0.6, urgent: 0.75, bigGate: 0.9 },
        },
      },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 200_000 },
      configDir: '/tmp/proma',
    })
    expect(input).toBeUndefined()
  })
})

describe('Live Compact 四条线：origin 上游只读档', () => {
  /** 上游 dsh-live-compact 的四值：20000 / 32000 / 48000 / 650000。 */
  const ORIGIN_LINES = [20_000, 32_000, 48_000, 650_000]

  function thresholdsFor(lineMode: 'origin', contextWindow: number): number[] {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true, lineMode } },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow },
      configDir: '/tmp/proma',
    })
    if (!input) throw new Error('origin 档应当已启用')
    return [
      input.thresholds.minPressureTokens,
      input.thresholds.keepRoundTokens,
      input.thresholds.urgentTokens,
      input.thresholds.bigGateTokens,
    ]
  }

  test('Given lineMode=origin When 小到 1M 的任何窗口 Then 四条线固定为上游 Origin 值', () => {
    for (const contextWindow of [50_000, 200_000, 1_000_000]) {
      expect(thresholdsFor('origin', contextWindow), `窗口 ${contextWindow}`).toEqual(ORIGIN_LINES)
    }
  })

  test('Given origin 且磁盘上还留着自定义组 When 组装 Then 自定义值不参与换算', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: {
        liveCompact: {
          enabled: true,
          lineMode: 'origin',
          ratios: { trigger: 0.6, keepRound: 0.45, urgent: 0.8, bigGate: 0.95 },
          absolute: {
            triggerTokens: 30_000,
            keepRoundTokens: 40_000,
            urgentTokens: 60_000,
            bigGateTokens: 90_000,
          },
        },
      },
      modelId: 'some-unknown-model',
      modelCapabilities: { contextWindow: 200_000 },
      configDir: '/tmp/proma',
    })

    expect(input?.thresholds.minPressureTokens).toBe(20_000)
    expect(input?.thresholds.keepRoundTokens).toBe(32_000)
    expect(input?.thresholds.urgentTokens).toBe(48_000)
    expect(input?.thresholds.bigGateTokens).toBe(650_000)
  })

  test('Given origin When 解析 overrides Then 明确降为 absolute 语义（保留线高于触发线合法）', () => {
    const resolved = resolveLiveCompactLineOverrides({ enabled: true, lineMode: 'origin' }, 200_000)

    expect(resolved.lineMode).toBe('absolute')
    expect(resolved.overrides).toEqual({
      minPressureTokens: 20_000,
      keepRoundTokens: 32_000,
      urgentTokens: 48_000,
      bigGateTokens: 650_000,
    })
  })

  test('Given origin When 组装 Then 主闸与结束轮保护照原样透传', () => {
    const protecting = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true, lineMode: 'origin', protectCurrentTurn: true } },
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })
    const unprotected = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true, lineMode: 'origin', protectCurrentTurn: false } },
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })

    expect(protecting?.enabled).toBe(true)
    expect(protecting?.protectCurrentTurn).toBe(true)
    expect(unprotected?.protectCurrentTurn).toBe(false)
  })
})

describe('Live Compact 当前轮保护透传', () => {
  test('Given 设置缺省 When 组装 Then protectCurrentTurn 为 true', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true } },
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })
    expect(input?.protectCurrentTurn).toBe(true)
  })

  test('Given 显式 false When 组装 Then protectCurrentTurn 为 false', () => {
    const input = buildLiveCompactQueryInput({
      meta: { liveCompact: true },
      settings: { liveCompact: { enabled: true, protectCurrentTurn: false } },
      modelId: 'some-unknown-model',
      configDir: '/tmp/proma',
    })
    expect(input?.protectCurrentTurn).toBe(false)
  })
})
