/**
 * Live Compact 四条线的渲染层模型测试
 *
 * 三类断言：
 * 1. 行为：试算取整、顺序校验、输入解析都必须与主进程语义一致；
 * 2. 契约：渲染层常量（比例缺省、上游 Origin）是主进程源码的副本，
 *    用 `readAppFile` 读 `src/main/lib/adapters/live-compact-thresholds.ts` 做**漂移守卫**，
 *    两边任一改动而另一侧没跟上就失败；
 * 3. 边界：渲染层不得 import 主进程模块（本仓无此先例，打包会带进 node 依赖）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  absoluteToDraft,
  calculateLinePreview,
  formatRatioPercent,
  formatTokenCount,
  LIVE_COMPACT_LINE_KEYS,
  LIVE_COMPACT_LINE_LABELS,
  LIVE_COMPACT_ORIGIN_KNOB_ROWS,
  LIVE_COMPACT_ORIGIN_LINE_ROWS,
  LIVE_COMPACT_ORIGIN_ROWS,
  parseLineNumber,
  parsePreviewWindow,
  PREVIEW_WINDOW_COMPARISON,
  PREVIEW_WINDOW_DEFAULT,
  RENDERER_DEFAULT_LINE_ABSOLUTE,
  RENDERER_DEFAULT_LINE_RATIOS,
  ratiosToDraft,
  toThresholdValue,
  validateLineDraft,
  type LiveCompactLineDraft,
} from './live-compact-line-model'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

/** 从主进程源码里读出某个模块级数值常量（支持 `export const` 与私有 `const`、数字分隔符）。 */
function readMainConstant(source: string, name: string): number {
  const pattern = new RegExp(`^(?:export )?const ${name} = ([0-9_.]+)$`, 'm')
  const match = pattern.exec(source)
  const raw = match?.[1]
  if (raw === undefined) throw new Error(`主进程源码里找不到常量 ${name}`)
  return Number(raw.replace(/_/g, ''))
}

const thresholdSource = readAppFile('src/main/lib/adapters/live-compact-thresholds.ts')
const modelSource = readAppFile('src/renderer/components/settings/live-compact-line-model.ts')

function draftOf(parts: Partial<LiveCompactLineDraft>): LiveCompactLineDraft {
  return {
    trigger: '0.5',
    keepRound: '0.35',
    urgent: '0.75',
    bigGate: '0.9',
    ...parts,
  }
}

function absoluteDraftOf(parts: Partial<LiveCompactLineDraft>): LiveCompactLineDraft {
  return {
    trigger: '20000',
    keepRound: '32000',
    urgent: '48000',
    bigGate: '650000',
    ...parts,
  }
}

/** 按 key 取 Origin 四条线的值；缺行直接抛错，避免可选链把缺失断言成 undefined 通过。 */
function originLineValue(key: string): number {
  const row = LIVE_COMPACT_ORIGIN_LINE_ROWS.find((candidate) => candidate.key === key)
  if (!row) throw new Error(`Origin 四条线缺少 ${key}`)
  return row.value
}

describe('Live Compact 四条线：缺省值与主进程漂移守卫', () => {
  test('Given 渲染层比例缺省 When 与主进程 RATIO 常量比对 Then 四个值逐一相等', () => {
    expect(RENDERER_DEFAULT_LINE_RATIOS.trigger).toBe(readMainConstant(thresholdSource, 'LIVE_COMPACT_TRIGGER_RATIO'))
    expect(RENDERER_DEFAULT_LINE_RATIOS.keepRound).toBe(readMainConstant(thresholdSource, 'LIVE_COMPACT_KEEP_ROUND_RATIO'))
    expect(RENDERER_DEFAULT_LINE_RATIOS.urgent).toBe(readMainConstant(thresholdSource, 'LIVE_COMPACT_URGENT_RATIO'))
    expect(RENDERER_DEFAULT_LINE_RATIOS.bigGate).toBe(readMainConstant(thresholdSource, 'LIVE_COMPACT_BIG_GATE_RATIO'))
    // 缺省组合本身必须通过渲染层校验，否则打开设置页就报错。
    expect(validateLineDraft('ratio', ratiosToDraft(RENDERER_DEFAULT_LINE_RATIOS)).ok).toBe(true)
  })

  test('Given 上游 Origin When 渲染层常量与主进程 UPSTREAM 常量比对 Then 四个 token 数逐一相等', () => {
    expect(originLineValue('trigger')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_MIN_TOKENS'))
    expect(originLineValue('keepRound')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_KEEP_ROUND_TOKENS'))
    expect(originLineValue('urgent')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_URGENT_TOKENS'))
    expect(originLineValue('bigGate')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_BIG_GATE'))

    // 绝对值缺省组必须与 Origin 四条线同源（同一份数字，不允许各写一套）。
    expect(RENDERER_DEFAULT_LINE_ABSOLUTE.triggerTokens).toBe(originLineValue('trigger'))
    expect(RENDERER_DEFAULT_LINE_ABSOLUTE.keepRoundTokens).toBe(originLineValue('keepRound'))
    expect(RENDERER_DEFAULT_LINE_ABSOLUTE.urgentTokens).toBe(originLineValue('urgent'))
    expect(RENDERER_DEFAULT_LINE_ABSOLUTE.bigGateTokens).toBe(originLineValue('bigGate'))
    expect(validateLineDraft('absolute', absoluteToDraft(RENDERER_DEFAULT_LINE_ABSOLUTE)).ok).toBe(true)
  })

  test('Given Origin 选段旋钮 When 与主进程私有常量比对 Then 五个值逐一相等', () => {
    const byKey = new Map(LIVE_COMPACT_ORIGIN_KNOB_ROWS.map((row) => [row.key, row.value]))

    expect(byKey.get('chunkMin')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_CHUNK_MIN_TOKENS'))
    expect(byKey.get('chunkMax')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_CHUNK_MAX_TOKENS'))
    expect(byKey.get('pointer')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_POINTER_TOKENS'))
    expect(byKey.get('keepRounds')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_KEEP_ROUNDS'))
    expect(byKey.get('cooldown')).toBe(readMainConstant(thresholdSource, 'UPSTREAM_COOLDOWN_MS'))
    expect(LIVE_COMPACT_ORIGIN_KNOB_ROWS).toHaveLength(5)
  })

  test('Given Origin 每行 When 检查 Then 环境变量键都是主进程真实读取的 env 名', () => {
    for (const row of LIVE_COMPACT_ORIGIN_ROWS) {
      if (row.configurability === 'env') {
        expect(row.envKey).toBeDefined()
        expect(thresholdSource).toContain(row.envKey as string)
        continue
      }      // 上游硬编码的两条线（紧急线、停手线）不得声称有 env 键。
      expect(row.envKey).toBeUndefined()
    }
    // 四条线的可配性与上游一致：前两条可由 env 覆盖，后两条硬编码。
    expect(LIVE_COMPACT_ORIGIN_LINE_ROWS.map((row) => row.configurability)).toEqual([
      'env',
      'env',
      'fixed',
      'fixed',
    ])
  })

  test('Given 渲染层模型 When 检查 import Then 不引用主进程模块', () => {
    // 只看真实 import 语句：文档注释里提到 `src/main/**` 不算依赖。
    const importLines = modelSource
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '))
    for (const line of importLines) {
      expect(line).not.toContain('/main/')
      expect(line).not.toContain('src/main')
    }
    // 唯一允许的跨包来源是 @proma/shared 桶（Pi 自动压缩线的来源）。
    expect(modelSource).toContain("from '@proma/shared'")
  })

  test('Given 四条线中文名 When 检查 Then 与设置页展示文案一致', () => {
    expect(LIVE_COMPACT_LINE_KEYS).toEqual(['trigger', 'keepRound', 'urgent', 'bigGate'])
    expect(LIVE_COMPACT_LINE_KEYS.map((key) => LIVE_COMPACT_LINE_LABELS[key])).toEqual([
      '起切线',
      '保留线',
      '紧急线',
      '停手线',
    ])
  })
})

describe('Live Compact 四条线：试算取整', () => {
  test('Given 200K 窗口与缺省比例 When 试算 Then 四线为 100K / 70K / 150K / 180K', () => {
    const preview = calculateLinePreview(PREVIEW_WINDOW_DEFAULT, RENDERER_DEFAULT_LINE_RATIOS)

    expect(preview.windowTokens).toBe(200_000)
    expect(preview.rows.map((row) => row.tokens)).toEqual([100_000, 70_000, 150_000, 180_000])
    expect(preview.rows.map((row) => row.key)).toEqual([...LIVE_COMPACT_LINE_KEYS])
  })

  test('Given 200K 窗口 When 对比 Pi 官方自动压缩线 Then 等于 80% 窗口', () => {
    const preview = calculateLinePreview(PREVIEW_WINDOW_DEFAULT, RENDERER_DEFAULT_LINE_RATIOS)

    expect(preview.piAutoCompactionTokens).toBe(160_000)
  })

  test('Given 1M 对照窗口 When 试算 Then 四线为 500K / 350K / 750K / 900K 且官方线 800K', () => {
    const preview = calculateLinePreview(PREVIEW_WINDOW_COMPARISON, RENDERER_DEFAULT_LINE_RATIOS)

    expect(preview.rows.map((row) => row.tokens)).toEqual([500_000, 350_000, 750_000, 900_000])
    expect(preview.piAutoCompactionTokens).toBe(800_000)
  })

  test('Given 会有小数尾巴的窗口 When 取整 Then 与主进程一致采用四舍五入且下限 1', () => {
    // 33333 × 0.35 = 11666.55 → 11667；与主进程 toThresholdValue 的 Math.round 一致。
    expect(toThresholdValue(33_333, 0.35)).toBe(11_667)
    expect(toThresholdValue(1, 0.01)).toBe(1)
    expect(toThresholdValue(0.5, 0.5)).toBe(1)
  })

  test('Given 非法窗口 When 试算 Then 直接抛错而不是返回 NaN', () => {
    expect(() => calculateLinePreview(0, RENDERER_DEFAULT_LINE_RATIOS)).toThrow(TypeError)
    expect(() => calculateLinePreview(Number.NaN, RENDERER_DEFAULT_LINE_RATIOS)).toThrow(TypeError)
  })
})

describe('Live Compact 四条线：比例模式校验', () => {
  test('Given 缺省草稿 When 校验 Then 通过并给出四条比例', () => {
    const result = validateLineDraft('ratio', draftOf({}))

    expect(result.ok).toBe(true)
    if (!result.ok || result.mode !== 'ratio') throw new Error('应通过比例校验')
    expect(result.ratios).toEqual(RENDERER_DEFAULT_LINE_RATIOS)
    expect(result.errors).toEqual({})
  })

  test('Given 保留线高于起切线 When 校验 Then 两个输入框都就地报错且不可保存', () => {
    const result = validateLineDraft('ratio', draftOf({ keepRound: '0.6' }))

    expect(result.ok).toBe(false)
    expect(result.errors.keepRound).toContain('保留线不能高于起切线')
    expect(result.errors.trigger).toContain('保留线不能高于起切线')
  })

  test('Given 起切线等于紧急线 When 校验 Then 报错并指出严格小于', () => {
    const result = validateLineDraft('ratio', draftOf({ trigger: '0.75' }))

    expect(result.ok).toBe(false)
    expect(result.errors.trigger).toBe('起切线必须严格低于紧急线')
    expect(result.errors.urgent).toBe('紧急线必须严格高于起切线')
  })

  test('Given 紧急线高于停手线 When 校验 Then 报错并指明哪条线更低', () => {
    const result = validateLineDraft('ratio', draftOf({ urgent: '0.95', bigGate: '0.9' }))

    expect(result.ok).toBe(false)
    expect(result.errors.urgent).toBe('紧急线必须严格低于停手线')
    expect(result.errors.bigGate).toBe('停手线必须严格高于紧急线')
  })

  test('Given 占比越出 0.01..0.99 When 校验 Then 就地报错（不静默夹取）', () => {
    for (const value of ['0', '0.001', '1', '1.2', '-0.3']) {
      const result = validateLineDraft('ratio', draftOf({ urgent: value }))
      expect(result.ok).toBe(false)
      expect(result.errors.urgent).toContain('占比需在')
    }
  })

  test('Given 空串或非数字 When 校验 Then 报“需要填数字”而不是被 Number("") 当成 0', () => {
    for (const value of ['', '   ', 'abc', '0.5x']) {
      const result = validateLineDraft('ratio', draftOf({ trigger: value }))
      expect(result.ok).toBe(false)
      expect(result.errors.trigger).toBe('起切线需要填数字')
    }
  })

  test('Given 带千分位逗号的输入 When 解析 Then 作为数字接受', () => {
    expect(parseLineNumber('20,000')).toBe(20_000)
    expect(parseLineNumber(' 0.35 ')).toBe(0.35)
    expect(parseLineNumber('')).toBeNull()
    expect(parseLineNumber(',')).toBeNull()
  })
})

describe('Live Compact 四条线：绝对值模式校验', () => {
  test('Given 上游 Origin 顺序（保留线 32000 高于起切线 20000）When 校验 Then 合法', () => {
    const result = validateLineDraft('absolute', absoluteDraftOf({}))

    expect(result.ok).toBe(true)
    if (!result.ok || result.mode !== 'absolute') throw new Error('应通过绝对值校验')
    expect(result.absolute).toEqual(RENDERER_DEFAULT_LINE_ABSOLUTE)
  })

  test('Given 起切线不低于紧急线 When 校验 Then 报错', () => {
    const result = validateLineDraft('absolute', absoluteDraftOf({ trigger: '48000' }))

    expect(result.ok).toBe(false)
    expect(result.errors.trigger).toBe('起切线必须严格低于紧急线')
  })

  test('Given 小数 token When 校验 Then 要求整数', () => {
    const result = validateLineDraft('absolute', absoluteDraftOf({ urgent: '48000.5' }))

    expect(result.ok).toBe(false)
    expect(result.errors.urgent).toContain('整数 token')
  })

  test('Given 越界 token When 校验 Then 报区间而不是交给主进程夹取', () => {
    const tooSmall = validateLineDraft('absolute', absoluteDraftOf({ trigger: '0' }))
    const tooLarge = validateLineDraft('absolute', absoluteDraftOf({ bigGate: '10000001' }))

    expect(tooSmall.ok).toBe(false)
    expect(tooSmall.errors.trigger).toContain('之间')
    expect(tooLarge.ok).toBe(false)
    expect(tooLarge.errors.bigGate).toContain('之间')
  })
})

describe('Live Compact 试算窗口输入', () => {
  test('Given 有效窗口 When 解析 Then 返回整数 token', () => {
    expect(parsePreviewWindow('200000')).toEqual({ value: 200_000, error: null })
    expect(parsePreviewWindow(' 1,000,000 ')).toEqual({ value: 1_000_000, error: null })
  })

  test('Given 非法窗口 When 解析 Then 返回就地错误', () => {
    expect(parsePreviewWindow('').error).toContain('填一个正的 token 数')
    expect(parsePreviewWindow('0').error).toContain('之间')
    expect(parsePreviewWindow('200000.5').error).toContain('整数')
    expect(parsePreviewWindow('abc').error).toContain('填一个正的 token 数')
  })
})

describe('Live Compact 展示格式', () => {
  test('Given token 数 When 格式化 Then 千分位可读', () => {
    expect(formatTokenCount(650_000)).toBe('650,000')
    expect(formatTokenCount(3)).toBe('3')
  })

  test('Given 占比 When 格式化 Then 转成百分比文案', () => {
    expect(formatRatioPercent(0.5)).toBe('50%')
    expect(formatRatioPercent(0.35)).toBe('35%')
    expect(formatRatioPercent(0.075)).toBe('7.5%')
  })
})
