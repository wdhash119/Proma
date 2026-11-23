import { describe, expect, test } from 'bun:test'
import {
  computeLiveCompactThresholds,
  describeLiveCompactThresholds,
  LIVE_COMPACT_BIG_GATE_RATIO,
  LIVE_COMPACT_KEEP_ROUND_RATIO,
  LIVE_COMPACT_THRESHOLD_SPECS,
  LIVE_COMPACT_TRIGGER_RATIO,
  LIVE_COMPACT_URGENT_RATIO,
  UPSTREAM_BIG_GATE,
  UPSTREAM_KEEP_ROUND_TOKENS,
  UPSTREAM_MIN_TOKENS,
  UPSTREAM_URGENT_TOKENS,
  type LiveCompactThresholdField,
} from './live-compact-thresholds'

describe('Live Compact 阈值：窗口比例映射', () => {
  test('Given 200K 窗口 When 换算 Then 触发线 100K / 保留轮 70K / 紧急线 150K', () => {
    const thresholds = computeLiveCompactThresholds(200000)
    expect(thresholds.minPressureTokens).toBe(100000)
    expect(thresholds.keepRoundTokens).toBe(70000)
    expect(thresholds.urgentTokens).toBe(150000)
    // 停手线按窗口比例给出（0.9W）：上游 650K 的绝对常数在窗口足够大时低于紧急线。
    expect(thresholds.bigGateTokens).toBe(180000)
    // 其余键沿用上游默认。
    expect(thresholds.chunkMinTokens).toBe(1000)
    expect(thresholds.chunkMaxTokens).toBe(32000)
    expect(thresholds.pointerTokens).toBe(32000)
    expect(thresholds.keepRounds).toBe(3)
    expect(thresholds.cooldownMs).toBe(0)
  })

  test('Given 128K 窗口 When 换算 Then 64000 / 44800 / 96000', () => {
    const thresholds = computeLiveCompactThresholds(128000)
    expect(thresholds.minPressureTokens).toBe(64000)
    expect(thresholds.keepRoundTokens).toBe(44800)
    expect(thresholds.urgentTokens).toBe(96000)
  })

  test('Given 50K 窗口 When 换算 Then 25000 / 17500 / 37500', () => {
    const thresholds = computeLiveCompactThresholds(50000)
    expect(thresholds.minPressureTokens).toBe(25000)
    expect(thresholds.keepRoundTokens).toBe(17500)
    expect(thresholds.urgentTokens).toBe(37500)
  })

  test('Given 任意窗口 When 换算 Then 三条主线严格有序且紧急线低于 Proma 自动压缩的 0.8W', () => {
    for (const window of [16000, 32000, 50000, 128000, 200000, 1000000]) {
      const thresholds = computeLiveCompactThresholds(window)
      expect(thresholds.keepRoundTokens).toBeLessThan(thresholds.minPressureTokens)
      expect(thresholds.minPressureTokens).toBeLessThan(thresholds.urgentTokens)
      expect(thresholds.urgentTokens).toBeLessThan(window * 0.8)
    }
  })
})

describe('Live Compact 阈值：语义键齐全', () => {
  test('Given 阈值表 When 检查 Then 每个数值字段都有语义与求值定义', () => {
    const thresholds = computeLiveCompactThresholds(200000)
    const fields = LIVE_COMPACT_THRESHOLD_SPECS.map((spec) => spec.field)
    expect(new Set(fields).size).toBe(fields.length)
    for (const spec of LIVE_COMPACT_THRESHOLD_SPECS) {
      expect(spec.semantics.length).toBeGreaterThan(0)
      expect(typeof thresholds[spec.field]).toBe('number')
      expect(Number.isFinite(thresholds[spec.field])).toBe(true)
      // 冷却窗允许为 0（= 只按压缩 id 让过一刀），其余阈值必须为正。
      if (spec.field === 'cooldownMs') {
        expect(thresholds[spec.field]).toBeGreaterThanOrEqual(0)
      } else {
        expect(thresholds[spec.field]).toBeGreaterThan(0)
      }
    }
  })

  test('Given 阈值对象 When 检查字段 Then 只包含九个数值字段与 env', () => {
    const thresholds = computeLiveCompactThresholds(50000)
    const keys = Object.keys(thresholds).sort()
    const expected: LiveCompactThresholdField[] = [
      'bigGateTokens',
      'chunkMaxTokens',
      'chunkMinTokens',
      'cooldownMs',
      'keepRoundTokens',
      'keepRounds',
      'minPressureTokens',
      'pointerTokens',
      'urgentTokens',
    ]
    expect(keys).toEqual([...expected, 'env'].sort())
  })

  test('Given 阈值描述 When 输出 Then 每行都是 键=值 形式', () => {
    const description = describeLiveCompactThresholds(computeLiveCompactThresholds(200000))
    expect(description).toContain('SPINE_MIN_TOKENS=100000')
    expect(description).toContain('SPINE_KEEP_ROUND_TOKENS=70000')
    expect(description).toContain('urgentTokens=150000')
  })
})

describe('Live Compact 阈值：env 记录', () => {
  test('Given 200K 窗口 When 取 env Then 只发算法真正读取的 SPINE_* 键', () => {
    const thresholds = computeLiveCompactThresholds(200000)
    expect(thresholds.env).toEqual({
      SPINE_MIN_TOKENS: '100000',
      SPINE_KEEP_ROUND_TOKENS: '70000',
      SPINE_CHUNK_MIN: '1000',
      SPINE_CHUNK_MAX: '32000',
      SPINE_POINTER_TOKENS: '32000',
      SPINE_KEEP_ROUNDS: '3',
    })
  })

  test('Given 阈值表 When 比对 env 键 Then 与算法层读取的键一一对应，且不含胶层自用阈值', () => {
    const thresholds = computeLiveCompactThresholds(128000)
    const envKeys = Object.keys(thresholds.env).sort()
    expect(envKeys).toEqual([
      'SPINE_CHUNK_MAX',
      'SPINE_CHUNK_MIN',
      'SPINE_KEEP_ROUNDS',
      'SPINE_KEEP_ROUND_TOKENS',
      'SPINE_MIN_TOKENS',
      'SPINE_POINTER_TOKENS',
    ])
    // 紧急线、停手线、冷却窗是胶层自用阈值，算法层没有对应 env 键。
    expect(envKeys).not.toContain('SPINE_URGENT_TOKENS')
    expect(envKeys).not.toContain('SPINE_COOLDOWN_MS')
  })

  test('Given 覆盖值 When 换算 Then env 记录跟随同一批已求值结果', () => {
    const thresholds = computeLiveCompactThresholds(200000, {
      minPressureTokens: 1000,
      keepRoundTokens: 500,
      urgentTokens: 2000,
      chunkMinTokens: 400,
      chunkMaxTokens: 8000,
      pointerTokens: 4000,
      keepRounds: 5,
      cooldownMs: 60000,
    })
    expect(thresholds.env).toEqual({
      SPINE_MIN_TOKENS: '1000',
      SPINE_KEEP_ROUND_TOKENS: '500',
      SPINE_CHUNK_MIN: '400',
      SPINE_CHUNK_MAX: '8000',
      SPINE_POINTER_TOKENS: '4000',
      SPINE_KEEP_ROUNDS: '5',
    })
  })

  test('Given 只覆盖单段最大 When 换算 Then 指针线跟随单段最大（上游默认关系）', () => {
    const thresholds = computeLiveCompactThresholds(200000, { chunkMaxTokens: 8000 })
    expect(thresholds.chunkMaxTokens).toBe(8000)
    expect(thresholds.pointerTokens).toBe(8000)
    expect(thresholds.env.SPINE_POINTER_TOKENS).toBe('8000')
  })

  test('Given 覆盖率常量 When 检查 Then 与实施方案的比例一致', () => {
    expect(LIVE_COMPACT_TRIGGER_RATIO).toBe(0.5)
    expect(LIVE_COMPACT_KEEP_ROUND_RATIO).toBe(0.35)
    expect(LIVE_COMPACT_URGENT_RATIO).toBe(0.75)
    expect(LIVE_COMPACT_BIG_GATE_RATIO).toBe(0.9)
  })
})

describe('Live Compact 阈值：绝对值模式', () => {
  test('Given 上游默认值（保留线 32000 高于起切线 20000）When 绝对值模式 Then 允许该顺序', () => {
    // 上游 Origin 就是这个顺序：云端 drain 每轮最多一刀，所以这条不变式只在比例模式成立。
    const thresholds = computeLiveCompactThresholds(
      200_000,
      {
        minPressureTokens: UPSTREAM_MIN_TOKENS,
        keepRoundTokens: UPSTREAM_KEEP_ROUND_TOKENS,
        urgentTokens: UPSTREAM_URGENT_TOKENS,
        bigGateTokens: UPSTREAM_BIG_GATE,
      },
      { lineMode: 'absolute' },
    )
    expect(thresholds.keepRoundTokens).toBe(32_000)
    expect(thresholds.minPressureTokens).toBe(20_000)
    expect(thresholds.keepRoundTokens).toBeGreaterThan(thresholds.minPressureTokens)
    expect(thresholds.urgentTokens).toBe(48_000)
    expect(thresholds.bigGateTokens).toBe(650_000)
    // env 记录仍然是同一批已求值结果。
    expect(thresholds.env.SPINE_MIN_TOKENS).toBe('20000')
    expect(thresholds.env.SPINE_KEEP_ROUND_TOKENS).toBe('32000')
  })

  test('Given 同样的 overrides When 比例模式 Then 仍然拒绝保留线高于起切线', () => {
    // 证明绝对值模式的放宽没有渗透到比例侧。
    expect(() => computeLiveCompactThresholds(200_000, {
      minPressureTokens: UPSTREAM_MIN_TOKENS,
      keepRoundTokens: UPSTREAM_KEEP_ROUND_TOKENS,
      urgentTokens: UPSTREAM_URGENT_TOKENS,
      bigGateTokens: UPSTREAM_BIG_GATE,
    })).toThrow(TypeError)
    expect(() => computeLiveCompactThresholds(200_000, {
      keepRoundTokens: 150_000,
    }, { lineMode: 'ratio' })).toThrow(TypeError)
  })

  test('Given 绝对值模式且未给 override When 换算 Then 四条线直取上游 Origin，不随窗口缩放', () => {
    for (const window of [50_000, 200_000, 1_000_000]) {
      const thresholds = computeLiveCompactThresholds(window, {}, { lineMode: 'absolute' })
      expect(thresholds.minPressureTokens).toBe(20_000)
      expect(thresholds.keepRoundTokens).toBe(32_000)
      expect(thresholds.urgentTokens).toBe(48_000)
      expect(thresholds.bigGateTokens).toBe(650_000)
    }
  })

  test('Given 绝对值模式 When 其余顺序非法 Then 仍然抛错', () => {
    // 放宽只针对“保留线 ≤ 起切线”；触发 / 紧急 / 停手 的顺序照旧校验。
    expect(() => computeLiveCompactThresholds(200_000, {
      minPressureTokens: 50_000,
      urgentTokens: 48_000,
    }, { lineMode: 'absolute' })).toThrow(TypeError)
    expect(() => computeLiveCompactThresholds(200_000, {
      urgentTokens: 700_000,
    }, { lineMode: 'absolute' })).toThrow(TypeError)
    expect(() => computeLiveCompactThresholds(200_000, {
      chunkMinTokens: 50_000,
    }, { lineMode: 'absolute' })).toThrow(TypeError)
  })
})

describe('Live Compact 阈值：非法输入', () => {
  test('Given 窗口非正 When 换算 Then 报 TypeError', () => {
    expect(() => computeLiveCompactThresholds(0)).toThrow(TypeError)
    expect(() => computeLiveCompactThresholds(Number.NaN)).toThrow(TypeError)
    expect(() => computeLiveCompactThresholds(-1)).toThrow(TypeError)
  })

  test('Given 保留轮预算高于触发线 When 换算 Then 拒绝', () => {
    expect(() => computeLiveCompactThresholds(200000, { keepRoundTokens: 200000 })).toThrow(TypeError)
  })

  test('Given 触发线不低于紧急线 When 换算 Then 拒绝', () => {
    expect(() => computeLiveCompactThresholds(200000, { minPressureTokens: 150000 })).toThrow(TypeError)
  })

  test('Given 单段最小高于最大 When 换算 Then 拒绝', () => {
    expect(() => computeLiveCompactThresholds(200000, { chunkMinTokens: 50000 })).toThrow(TypeError)
  })

  test('Given 冷却窗为负 When 换算 Then 拒绝', () => {
    expect(() => computeLiveCompactThresholds(200000, { cooldownMs: -1 })).toThrow(TypeError)
  })
})
