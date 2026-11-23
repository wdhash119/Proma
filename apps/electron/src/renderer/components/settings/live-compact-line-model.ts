/**
 * Live Compact 四条线的渲染层纯模型
 *
 * 设置页要展示/校验/试算四条线，但渲染进程**不能** import `src/main/**`
 * （本仓无此先例：阈值数学与上游 Origin 常量都住主进程）。因此这里放一份
 * 渲染层自用的常量副本 + 纯函数，并由 `live-compact-line-model.test.ts` 用
 * `readAppFile` 读主进程源码做**漂移守卫**：两边数字不一致时测试直接失败。
 *
 * 与主进程对齐的三条硬约束：
 * 1. 比例缺省 0.5 / 0.35 / 0.75 / 0.9，绝对值缺省等于上游 Origin
 *    （20000 / 32000 / 48000 / 650000）；
 * 2. 比例组必须满足 `keepRound ≤ trigger < urgent < bigGate`，组内顺序非法整组回落缺省；
 *    绝对值组只校验 `trigger < urgent < bigGate`（上游 Origin 的保留线 32000 高于起切线 20000
 *    是既定顺序：云端每轮收尾最多一刀）；
 * 3. 取整一律 `Math.max(1, Math.round(窗口 × 占比))`，与主进程 `toThresholdValue` 一致。
 *
 * 所有数值字段必须先转成 `number` 再落盘：`normalizeLiveCompactSettings` 只认数字类型，
 * 传字符串会被判定为缺失从而整组回落默认——这正是本模块把“输入框字符串 → 数值”单独
 * 拎成 `parseLineNumber` 的原因。
 *
 * 比例在**输入框里是百分数**（`50` 表示 50% 窗口），存储域仍是 fraction（`0.5`）。
 * `ratiosToDraft` 与 `validateLineDraft` 在边界上完成 100 倍换算，调用方不需要自己乘除：
 * 界面上不再出现 `0.075` 这类分数，也不会把 `50` 当成 50 倍窗口写进设置。
 */

import { calculatePiAutoCompactionThresholdTokens } from '@proma/shared'
import type {
  LiveCompactLineAbsolute,
  LiveCompactLineRatios,
} from '@/types/settings'

/** 四条线的键，顺序即设置页展示顺序（起切 → 保留 → 紧急 → 停手）。 */
export const LIVE_COMPACT_LINE_KEYS = ['trigger', 'keepRound', 'urgent', 'bigGate'] as const

/** 单条线的键。 */
export type LiveCompactLineKey = (typeof LIVE_COMPACT_LINE_KEYS)[number]

/** 四条线的中文名（设置页、Origin 卡与错误文案共用，避免各处重写）。 */
export const LIVE_COMPACT_LINE_LABELS: Readonly<Record<LiveCompactLineKey, string>> = {
  trigger: '起切线',
  keepRound: '保留线',
  urgent: '紧急线',
  bigGate: '停手线',
}

/**
 * 比例模式缺省占比（与 `live-compact-thresholds.ts` 的四个 RATIO 常量同值）。
 * 主进程仍是唯一权威来源，这里只是渲染层展示缺省值用；漂移由测试兜住。
 */
export const RENDERER_DEFAULT_LINE_RATIOS: LiveCompactLineRatios = {
  trigger: 0.5,
  keepRound: 0.35,
  urgent: 0.75,
  bigGate: 0.9,
}

/** 绝对值模式缺省 = 上游 Origin 的四个 token 数。 */
export const RENDERER_DEFAULT_LINE_ABSOLUTE: LiveCompactLineAbsolute = {
  triggerTokens: 20_000,
  keepRoundTokens: 32_000,
  urgentTokens: 48_000,
  bigGateTokens: 650_000,
}

/** 比例输入的合法区间：与主进程归一化的 clamp 区间一致，避免“页面接受、落盘被改”。 */
export const LINE_RATIO_MIN = 0.01
export const LINE_RATIO_MAX = 0.99
/** 绝对值输入的合法区间：与主进程归一化的 clamp 区间一致。 */
export const LINE_TOKENS_MIN = 1
export const LINE_TOKENS_MAX = 10_000_000

/** 试算上下文长度的缺省值（200K，最常见的云端窗口）。 */
export const PREVIEW_WINDOW_DEFAULT = 200_000
/** 试算对照窗口（1M，最大级别窗口；上游 Origin 在这种窗口下会把上下文压到 32K）。 */
export const PREVIEW_WINDOW_COMPARISON = 1_000_000

/** 上游 Origin 某个值能否被覆盖。 */
export type LiveCompactOriginConfigurability = 'env' | 'fixed'

/** Origin 只读卡的一行。 */
export interface LiveCompactOriginRow {
  /** 稳定标识，同时用作 React key。 */
  key: string
  label: string
  /** 上游原值。 */
  value: number
  /** 展示单位。 */
  unit: 'token' | '轮' | '毫秒'
  /** env = 可用环境变量覆盖；fixed = 上游硬编码，不可配。 */
  configurability: LiveCompactOriginConfigurability
  /** 可覆盖时对应的 env 键。 */
  envKey?: string
  /** 该值在上游的作用（中文语义，直接展示）。 */
  note: string
}

/**
 * Origin 四条线：dsh-live-compact 的绝对值 token 数。
 *
 * 前两条可由 env 覆盖，后两条在上游 `index.js` 里硬编码。
 */
export const LIVE_COMPACT_ORIGIN_LINE_ROWS: readonly LiveCompactOriginRow[] = [
  {
    key: 'trigger',
    label: '起切线',
    value: 20_000,
    unit: 'token',
    configurability: 'env',
    envKey: 'SPINE_MIN_TOKENS',
    note: '上下文占用低于它时整个 turn 直接返回，不选段也不切',
  },
  {
    key: 'keepRound',
    label: '保留线',
    value: 32_000,
    unit: 'token',
    configurability: 'env',
    envKey: 'SPINE_KEEP_ROUND_TOKENS',
    note: '保留轮总预算，同时是云端收尾（drain）的停止水位',
  },
  {
    key: 'urgent',
    label: '紧急线',
    value: 48_000,
    unit: 'token',
    configurability: 'fixed',
    note: '云端占用达到它即强制收尾；上游硬编码，不可配',
  },
  {
    key: 'bigGate',
    label: '停手线',
    value: 650_000,
    unit: 'token',
    configurability: 'fixed',
    note: '总量达到即完全让位给官方自动压缩；上游硬编码，不可配',
  },
]

/**
 * Origin 选段旋钮：本次只读展示，设置页不提供编辑入口。
 *
 * 这些值上游在模块加载时读 env 并求值成常量，运行期再改无效（要改只能重新 fork 子进程）。
 */
export const LIVE_COMPACT_ORIGIN_KNOB_ROWS: readonly LiveCompactOriginRow[] = [
  {
    key: 'chunkMin',
    label: '单段最小',
    value: 1_000,
    unit: 'token',
    configurability: 'env',
    envKey: 'SPINE_CHUNK_MIN',
    note: '本地引擎的收益门槛、长读轮判定线与指针切分下限',
  },
  {
    key: 'chunkMax',
    label: '单段最大',
    value: 32_000,
    unit: 'token',
    configurability: 'env',
    envKey: 'SPINE_CHUNK_MAX',
    note: '一段切分向左扩张的上限',
  },
  {
    key: 'pointer',
    label: '指针化阈值',
    value: 32_000,
    unit: 'token',
    configurability: 'env',
    envKey: 'SPINE_POINTER_TOKENS',
    note: '单条工具结果达到它就换成只留调用与退出码的指针卡；缺省跟随单段最大',
  },
  {
    key: 'keepRounds',
    label: '保留轮数',
    value: 3,
    unit: '轮',
    configurability: 'env',
    envKey: 'SPINE_KEEP_ROUNDS',
    note: '最新这几个已结束的工具轮不参与切分',
  },
  {
    key: 'cooldown',
    label: '冷却窗',
    value: 0,
    unit: '毫秒',
    configurability: 'env',
    envKey: 'SPINE_COOLDOWN_MS',
    note: '官方压缩后的时间冷却窗；0 表示只按压缩 id 的身份规则让过一刀',
  },
]

/** Origin 全表（四条线 + 五个选段旋钮），顺序即展示顺序。 */
export const LIVE_COMPACT_ORIGIN_ROWS: readonly LiveCompactOriginRow[] = [
  ...LIVE_COMPACT_ORIGIN_LINE_ROWS,
  ...LIVE_COMPACT_ORIGIN_KNOB_ROWS,
]

/** token 数的可读格式（千分位）；写死 locale 保证测试与界面一致。 */
export function formatTokenCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** 占比转百分比文案：0.35 → 35%，0.075 → 7.5%。 */
export function formatRatioPercent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`
}

/**
 * 窗口 × 占比 → token 阈值。
 *
 * 与主进程 `toThresholdValue` 完全一致：先乘再四舍五入，下限 1（0 会让整条线失效）。
 */
export function toThresholdValue(windowTokens: number, ratio: number): number {
  return Math.max(1, Math.round(windowTokens * ratio))
}

/** 试算结果里的一行。 */
export interface LiveCompactPreviewRow {
  key: LiveCompactLineKey
  label: string
  ratio: number
  tokens: number
}

/** 比例模式的试算结果。 */
export interface LiveCompactLinePreview {
  windowTokens: number
  rows: LiveCompactPreviewRow[]
  /** Pi 官方自动压缩线（packages/shared 的 pi-compaction 语义，窗口 − 预留 20%）。 */
  piAutoCompactionTokens: number
}

/**
 * 按某个窗口把四条比例线换算成 token 数，并附上 Pi 官方自动压缩线作对比。
 *
 * 纯预览：结果不落盘、不影响生效值。调用方必须保证 `windowTokens` 为正有限数、
 * `ratios` 已通过 `validateLineDraft`（否则这里直接抛错，避免把 NaN 糊到界面上）。
 */
export function calculateLinePreview(
  windowTokens: number,
  ratios: LiveCompactLineRatios,
): LiveCompactLinePreview {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) {
    throw new TypeError(`试算需要正的有限窗口大小，收到 ${String(windowTokens)}`)
  }
  return {
    windowTokens,
    rows: LIVE_COMPACT_LINE_KEYS.map((key) => ({
      key,
      label: LIVE_COMPACT_LINE_LABELS[key],
      ratio: ratios[key],
      tokens: toThresholdValue(windowTokens, ratios[key]),
    })),
    piAutoCompactionTokens: calculatePiAutoCompactionThresholdTokens(windowTokens),
  }
}

/** 四条线在绝对值组里的字段名，换算预览按它取值（顺序与 LIVE_COMPACT_LINE_KEYS 一致）。 */
const ABSOLUTE_FIELD_BY_KEY: Readonly<Record<LiveCompactLineKey, keyof LiveCompactLineAbsolute>> = {
  trigger: 'triggerTokens',
  keepRound: 'keepRoundTokens',
  urgent: 'urgentTokens',
  bigGate: 'bigGateTokens',
}

/** 当前生效的自定义组（渲染层口径，origin 不参与换算预览）。 */
export type LiveCompactEffectiveGroup =
  | { mode: 'ratio'; ratios: LiveCompactLineRatios }
  | { mode: 'absolute'; absolute: LiveCompactLineAbsolute }

/** 换算预览的一行。 */
export interface LiveCompactConvertedLine {
  key: LiveCompactLineKey
  label: string
  /** 比例列是百分数（50 = 50%），绝对值列是 token 数。 */
  value: number
  /** 灰框里直接展示的文案，不参与保存。 */
  text: string
}

/** 非生效列的换算预览。 */
export interface LiveCompactConversionPreview {
  /** 被预览的那一列（即非生效列）。 */
  column: 'ratio' | 'absolute'
  windowTokens: number
  rows: LiveCompactConvertedLine[]
}

/**
 * 按“参考上下文长度”把生效组换算成另一列的预览值。
 *
 * - 比例生效 → 预览绝对值列：`Math.max(1, Math.round(窗口 × 比例))`，与主进程取整完全一致；
 * - 绝对值生效 → 预览比例列：`token / 窗口` 转百分比文案（最多一位小数）。
 *
 * 纯展示：不落盘、不影响生效值。`windowTokens` 非正或非有限时直接抛错，
 * 避免把 NaN 或 Infinity 渲染进灰框（与 `calculateLinePreview` 同语义）。
 */
export function calculateConversionPreview(
  group: LiveCompactEffectiveGroup,
  windowTokens: number,
): LiveCompactConversionPreview {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) {
    throw new TypeError(`换算预览需要正的有限窗口大小，收到 ${String(windowTokens)}`)
  }
  if (group.mode === 'ratio') {
    return {
      column: 'absolute',
      windowTokens,
      rows: LIVE_COMPACT_LINE_KEYS.map((key) => {
        const tokens = toThresholdValue(windowTokens, group.ratios[key])
        return {
          key,
          label: LIVE_COMPACT_LINE_LABELS[key],
          value: tokens,
          text: formatTokenCount(tokens),
        }
      }),
    }
  }
  return {
    column: 'ratio',
    windowTokens,
    rows: LIVE_COMPACT_LINE_KEYS.map((key) => {
      const tokens = group.absolute[ABSOLUTE_FIELD_BY_KEY[key]]
      const ratio = tokens / windowTokens
      return {
        key,
        label: LIVE_COMPACT_LINE_LABELS[key],
        value: Math.round(ratio * 1000) / 10,
        text: formatRatioPercent(ratio),
      }
    }),
  }
}

/** 可编辑的取值模式：`origin` 是只读档，不参与草稿校验与换算预览。 */
export type LiveCompactEditableLineMode = 'ratio' | 'absolute'

/** 四条线输入框的字符串草稿（保存前才转成数值）。 */
export interface LiveCompactLineDraft {
  trigger: string
  keepRound: string
  urgent: string
  bigGate: string
}

/**
 * 校验结果：错误按字段就地挂回对应输入框，`ok` 决定保存按钮可用性。
 *
 * 用判别联合表示：`ok === true` 时必定只有当前模式那一组值，调用方不需要做非空断言，
 * 也就不会出现“校验通过却把 null 发出去”的缝隙。
 */
export type LiveCompactLineValidation =
  | {
      ok: true
      mode: 'ratio'
      errors: Partial<Record<LiveCompactLineKey, string>>
      ratios: LiveCompactLineRatios
    }
  | {
      ok: true
      mode: 'absolute'
      errors: Partial<Record<LiveCompactLineKey, string>>
      absolute: LiveCompactLineAbsolute
    }
  | {
      ok: false
      mode: LiveCompactEditableLineMode
      errors: Partial<Record<LiveCompactLineKey, string>>
    }

/**
 * 比例组 → 百分数草稿（输入框里的 `50` = 50% 窗口）。
 *
 * 乘 10000 再四舍五入再除 100：`0.35 → 35`、`0.075 → 7.5`，
 * 避开 `0.35 * 100 = 35.000000000000004` 这类浮点噪声被写进输入框。
 */
export function ratiosToDraft(ratios: LiveCompactLineRatios): LiveCompactLineDraft {
  return {
    trigger: String(ratioToPercentValue(ratios.trigger)),
    keepRound: String(ratioToPercentValue(ratios.keepRound)),
    urgent: String(ratioToPercentValue(ratios.urgent)),
    bigGate: String(ratioToPercentValue(ratios.bigGate)),
  }
}

/** fraction（0.5）→ 百分数（50），保留最多两位小数。 */
export function ratioToPercentValue(ratio: number): number {
  return Math.round(ratio * 10_000) / 100
}

/** 绝对值组 → 草稿。 */
export function absoluteToDraft(absolute: LiveCompactLineAbsolute): LiveCompactLineDraft {
  return {
    trigger: String(absolute.triggerTokens),
    keepRound: String(absolute.keepRoundTokens),
    urgent: String(absolute.urgentTokens),
    bigGate: String(absolute.bigGateTokens),
  }
}

/**
 * 输入框字符串 → 数值。
 *
 * 允许千分位逗号与首尾空格；空串与“解析后不是有限数”都返回 null。
 * 注意不能用 `Number('')`（它等于 0），所以空串先单独拦掉。
 */
export function parseLineNumber(raw: string): number | null {
  const trimmed = raw.replace(/,/g, '').trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** 逐字段的“能否解析 + 区间是否合法”检查，返回数值与就地错误。 */
function parseLines(
  mode: LiveCompactEditableLineMode,
  draft: LiveCompactLineDraft,
): { values: Partial<Record<LiveCompactLineKey, number>>; errors: Partial<Record<LiveCompactLineKey, string>> } {
  const values: Partial<Record<LiveCompactLineKey, number>> = {}
  const errors: Partial<Record<LiveCompactLineKey, string>> = {}
  // 比例在输入框里是百分数，但存储域是 fraction：区间校验用百分数口径，写回前除以 100。
  const percentMin = ratioToPercentValue(LINE_RATIO_MIN)
  const percentMax = ratioToPercentValue(LINE_RATIO_MAX)
  for (const key of LIVE_COMPACT_LINE_KEYS) {
    const label = LIVE_COMPACT_LINE_LABELS[key]
    const parsed = parseLineNumber(draft[key])
    if (parsed === null) {
      errors[key] = `${label}需要填数字`
      continue
    }
    if (mode === 'ratio') {
      if (parsed < percentMin || parsed > percentMax) {
        errors[key] = `${label}占比需在 ${percentMin}% 与 ${percentMax}% 之间`
        continue
      }
      values[key] = parsed / 100
      continue
    }
    if (!Number.isInteger(parsed)) {
      errors[key] = `${label}需要整数 token`
      continue
    }
    if (parsed < LINE_TOKENS_MIN || parsed > LINE_TOKENS_MAX) {
      errors[key] = `${label}需在 ${formatTokenCount(LINE_TOKENS_MIN)} 与 ${formatTokenCount(LINE_TOKENS_MAX)} token 之间`
      continue
    }
    values[key] = parsed
  }
  return { values, errors }
}

/**
 * 校验四条线草稿。
 *
 * - 比例模式：草稿是百分数（`50` = 50%），校验后换算回 fraction（`0.5`）再输出，
 *   组内需满足 `keepRound ≤ trigger < urgent < bigGate`（与主进程组内顺序校验一致）；
 * - 绝对值模式：只校验 `trigger < urgent < bigGate`，不限制保留线与起切线的先后
 *   （上游 Origin 就是保留线 32000 > 起切线 20000）。
 *
 * 顺序错误同时挂到相邻两个输入框上，用户改任意一侧都能看到提示。
 */
export function validateLineDraft(
  mode: LiveCompactEditableLineMode,
  draft: LiveCompactLineDraft,
): LiveCompactLineValidation {
  const { values, errors } = parseLines(mode, draft)

  const trigger = values.trigger
  const keepRound = values.keepRound
  const urgent = values.urgent
  const bigGate = values.bigGate
  // 四项任一缺失/非法就不做顺序校验：先让用户把单个格子填对。
  if (trigger === undefined || keepRound === undefined || urgent === undefined || bigGate === undefined) {
    return { ok: false, mode, errors }
  }

  if (mode === 'ratio' && keepRound > trigger) {
    const message = `保留线不能高于起切线（${formatRatioPercent(trigger)} 窗口）`
    errors.keepRound = message
    errors.trigger = message
  }
  if (trigger >= urgent) {
    errors.trigger = '起切线必须严格低于紧急线'
    errors.urgent = '紧急线必须严格高于起切线'
  }
  if (urgent >= bigGate) {
    errors.urgent = '紧急线必须严格低于停手线'
    errors.bigGate = '停手线必须严格高于紧急线'
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, mode, errors }
  }
  if (mode === 'ratio') {
    return { ok: true, mode, errors, ratios: { trigger, keepRound, urgent, bigGate } }
  }
  return {
    ok: true,
    mode,
    errors,
    absolute: {
      triggerTokens: trigger,
      keepRoundTokens: keepRound,
      urgentTokens: urgent,
      bigGateTokens: bigGate,
    },
  }
}

/** 试算窗口输入框的校验：正整数 token，返回数值或就地错误。 */
export function parsePreviewWindow(raw: string): { value: number | null; error: string | null } {
  const parsed = parseLineNumber(raw)
  if (parsed === null) return { value: null, error: '填一个正的 token 数' }
  if (!Number.isInteger(parsed)) return { value: null, error: '需要整数 token' }
  if (parsed < 1 || parsed > LINE_TOKENS_MAX) {
    return { value: null, error: `需在 1 与 ${formatTokenCount(LINE_TOKENS_MAX)} 之间` }
  }
  return { value: parsed, error: null }
}
