/**
 * Live Compact 阈值的唯一来源（上游 pi-live-compact 0.12.0 的 Proma 化换算）。
 *
 * 上游把阈值拆在两层：
 * 1. 算法层 `select.ts` 在**模块加载时**读 SPINE_CHUNK_MIN / SPINE_CHUNK_MAX /
 *    SPINE_POINTER_TOKENS / SPINE_KEEP_ROUNDS / SPINE_KEEP_ROUND_TOKENS，求值成模块级常量，
 *    运行期不再变化 —— 所以要改这些值只能靠子进程 fork env（P2b 的注入面）。
 * 2. 宿主胶层读 SPINE_MIN_TOKENS 作为触发线，并硬编码紧急线 48000、停手线 650000。
 *
 * 这些上游默认值面向约 32K–50K 的小窗口（MIN_PRESSURE=20000、KEEP_ROUND_TOKENS=32000），
 * 直接照搬到 Proma 的 128K–200K+ 云端会话会把上下文压到 32K 左右，比 Proma 现有
 * “约 80% 窗口才自动压缩”激进一个数量级。因此 Proma 按模型窗口比例换算四条线：
 * 触发线 0.5W、保留轮预算 0.35W、紧急线 0.75W（紧急线刻意低于 Proma 自带自动压缩的
 * 0.8W：spine 先行、官方压缩兜底）、停手线 0.9W。算法层的四个选段旋钮（单段最小/最大、
 * 指针化阈值、保留轮数）沿用上游默认值。
 *
 * 本文件同时产出两种形态，且**只在这张表里求值一次**：
 * - typed 对象：胶层（pi-live-compact-extension.ts）直接消费；
 * - env 字符串记录：P2b 注入 utility 进程 fork env，供算法层模块加载时读取。
 */

/** 窗口占比：触发线（上游 MIN_PRESSURE=20000 的 Proma 化）。 */
export const LIVE_COMPACT_TRIGGER_RATIO = 0.5
/** 窗口占比：保留轮预算 / 云端 drain 目标线（上游 KEEP_ROUND_TOKENS=32000 的 Proma 化）。 */
export const LIVE_COMPACT_KEEP_ROUND_RATIO = 0.35
/**
 * 窗口占比：紧急线（上游硬编码 URGENT_TOKENS=48000 的 Proma 化）。
 * 必须严格低于 Proma 自带自动压缩的 0.8W（packages/shared/src/utils/pi-compaction.ts），
 * 否则 spine 与官方压缩会抢同一条线。
 */
export const LIVE_COMPACT_URGENT_RATIO = 0.75
/**
 * 窗口占比：停手线（上游 BIG_GATE=650000 的 Proma 化）。
 *
 * 上游这个 650000 是面向小窗口的绝对常数，在 1M 级窗口上会低于紧急线而自相矛盾。
 * 它的真实语义是“总量已经大到 spine 拉不回来，完全让位给官方压缩”，因此同样按窗口
 * 比例给出：0.9W 严格高于紧急线 0.75W，且已越过官方压缩的 0.8W（spine 平时到不了）。
 */
export const LIVE_COMPACT_BIG_GATE_RATIO = 0.9

/** 上游 select.ts 的 CHUNK_MIN 默认值（issue #15 的 env 旋钮，默认不变）。 */
const UPSTREAM_CHUNK_MIN_TOKENS = 1000
/** 上游 plan.ts 的 RAIL_TOKENS，也是 select.ts CHUNK_MAX 的默认值。 */
const UPSTREAM_CHUNK_MAX_TOKENS = 32000
/** 上游 select.ts 的 POINTER_TOKENS 默认值：等于 CHUNK_MAX。 */
const UPSTREAM_POINTER_TOKENS = 32000
/** 上游 select.ts 的 KEEP_ROUNDS 默认值：保留最新 3 个已结束工具轮。 */
const UPSTREAM_KEEP_ROUNDS = 3
/**
 * 上游胶层 `resolveCooldownMs()` 在没有 SPINE_COOLDOWN_MS 时返回 0：
 * 时间窗关闭，只按“同一 compression id 让过一刀”的身份规则工作。
 */
const UPSTREAM_COOLDOWN_MS = 0

/** 阈值对象里不带 env 记录的纯数值字段名。 */
export type LiveCompactThresholdField = keyof LiveCompactThresholdValues

/** 阈值数值本体（不含 env 记录）。 */
export interface LiveCompactThresholdValues {
  /** 触发线：上下文占用低于它时整个 turn 直接返回。 */
  minPressureTokens: number
  /** 保留轮预算 / 云端 drain 目标线。 */
  keepRoundTokens: number
  /** 紧急线：云端占用达到它即强制 drain。 */
  urgentTokens: number
  /** 停手线：总量达到即完全让位给官方压缩。 */
  bigGateTokens: number
  /** 单段最小 token。 */
  chunkMinTokens: number
  /** 单段最大 token。 */
  chunkMaxTokens: number
  /** 单条工具结果的指针化阈值。 */
  pointerTokens: number
  /** 保留的最新已结束工具轮数。 */
  keepRounds: number
  /** 官方压缩后的时间冷却窗（毫秒，0 = 关闭时间窗）。 */
  cooldownMs: number
}

export interface LiveCompactThresholds extends LiveCompactThresholdValues {
  /**
   * P2b 的 fork env 注入记录。只包含算法层真正读取的 SPINE_* 键：
   * 胶层自用阈值（紧急线、停手线、冷却窗）不发 env，
   * 避免往子进程环境里塞不被任何代码读取的变量。
   */
  env: Readonly<Record<string, string>>
}

export interface LiveCompactThresholdOverrides {
  minPressureTokens?: number
  keepRoundTokens?: number
  urgentTokens?: number
  bigGateTokens?: number
  chunkMinTokens?: number
  chunkMaxTokens?: number
  pointerTokens?: number
  keepRounds?: number
  cooldownMs?: number
}

/** 单个阈值的定义：语义、env 键与求值方式。表内顺序即求值顺序。 */
export interface LiveCompactThresholdSpec {
  field: LiveCompactThresholdField
  /** 算法层/上游胶层读取的 env 键；纯胶层阈值没有 env 键。 */
  envKey?: string
  /** 中文语义（设置页与文档复用这份措辞，避免各处重写）。 */
  semantics: string
  /** 求值：可使用窗口大小与表中已求出的前序字段。 */
  resolve: (input: {
    contextWindow: number
    resolved: Partial<Record<LiveCompactThresholdField, number>>
  }) => number
}

/**
 * 键 → 语义 → 取值来源。
 *
 * 语义核对结论（对照 select.ts / plan.ts 实读）：
 * - KEEP_ROUND_TOKENS 有两处消费：(a) `chooseKeptSpan(rounds, spanTokens, budget)` 的
 *   保留轮总预算；(b) 胶层云端 drain 的停止目标（`simTotal <= KEEP_ROUND_TOKENS`）。
 *   两者都是“压后想留住的窗口大小”，所以 0.35W 的映射语义成立，不是“单轮预算”。
 * - POINTER_TOKENS 的默认值等于 CHUNK_MAX，是“单条工具结果大到可以直接换成指针卡”的线。
 * - CHUNK_MIN 同时是本地引擎的 gain 门槛、长读轮判定线、指针切分的下限。
 */
export const LIVE_COMPACT_THRESHOLD_SPECS: readonly LiveCompactThresholdSpec[] = [
  {
    field: 'minPressureTokens',
    envKey: 'SPINE_MIN_TOKENS',
    semantics: '触发线：上下文占用低于它时整个 turn 直接返回，不选段也不切',
    resolve: ({ contextWindow }) => contextWindow * LIVE_COMPACT_TRIGGER_RATIO,
  },
  {
    field: 'keepRoundTokens',
    envKey: 'SPINE_KEEP_ROUND_TOKENS',
    semantics: '保留轮预算：最新若干工具轮的总 token 预算，同时是云端 drain 的压后目标线',
    resolve: ({ contextWindow }) => contextWindow * LIVE_COMPACT_KEEP_ROUND_RATIO,
  },
  {
    field: 'urgentTokens',
    semantics: '紧急线：云端占用达到它即强制 drain（上游硬编码 48000，Proma 改为窗口比例）',
    resolve: ({ contextWindow }) => contextWindow * LIVE_COMPACT_URGENT_RATIO,
  },
  {
    field: 'bigGateTokens',
    semantics: '停手线：总量达到即完全让位给官方压缩，不再切',
    resolve: ({ contextWindow }) => contextWindow * LIVE_COMPACT_BIG_GATE_RATIO,
  },
  {
    field: 'chunkMinTokens',
    envKey: 'SPINE_CHUNK_MIN',
    semantics: '单段最小 token：本地引擎 gain 门槛、长读轮判定线、指针切分下限',
    resolve: () => UPSTREAM_CHUNK_MIN_TOKENS,
  },
  {
    field: 'chunkMaxTokens',
    envKey: 'SPINE_CHUNK_MAX',
    semantics: '单段最大 token：一段切分向左扩张的上限（上游 RAIL_TOKENS）',
    resolve: () => UPSTREAM_CHUNK_MAX_TOKENS,
  },
  {
    field: 'pointerTokens',
    envKey: 'SPINE_POINTER_TOKENS',
    semantics: '指针化阈值：单条工具结果达到它就允许换成只留调用与退出码的指针卡',
    // 上游默认“等于 CHUNK_MAX”：chunkMax 被覆盖时指针线随之移动，除非单独覆盖。
    resolve: ({ resolved }) => resolved.chunkMaxTokens ?? UPSTREAM_POINTER_TOKENS,
  },
  {
    field: 'keepRounds',
    envKey: 'SPINE_KEEP_ROUNDS',
    semantics: '保留的最新已结束工具轮数：这些轮不会被切',
    resolve: () => UPSTREAM_KEEP_ROUNDS,
  },
  {
    field: 'cooldownMs',
    semantics: '官方压缩后的时间冷却窗（毫秒）：0 表示只按压缩 id 的身份规则让过一刀',
    resolve: () => UPSTREAM_COOLDOWN_MS,
  },
]

/** 允许取 0 的字段（冷却窗 0 = 关闭时间窗）；其余必须是正整数。 */
const ZERO_ALLOWED_FIELDS = new Set<LiveCompactThresholdField>(['cooldownMs'])

function toThresholdValue(field: LiveCompactThresholdField, raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new TypeError(`Live Compact 阈值 ${field} 必须是有限数值，收到 ${String(raw)}`)
  }
  if (ZERO_ALLOWED_FIELDS.has(field)) {
    if (raw < 0) throw new TypeError(`Live Compact 阈值 ${field} 不能为负，收到 ${raw}`)
    return Math.round(raw)
  }
  if (raw <= 0) throw new TypeError(`Live Compact 阈值 ${field} 必须为正，收到 ${raw}`)
  return Math.max(1, Math.round(raw))
}

/**
 * 由模型窗口换算出全套阈值。
 *
 * overrides 只用于（a）测试构造确定的取值、（b）P2b 之后的设置项；缺省一律按
 * 窗口比例与上游默认值求值。返回对象里的 env 记录由**同一批已求值结果**生成，
 * 因此胶层参数与子进程 env 不可能出现两份来源。
 */
export function computeLiveCompactThresholds(
  contextWindow: number,
  overrides: LiveCompactThresholdOverrides = {},
): LiveCompactThresholds {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new TypeError(`Live Compact 需要正的有限窗口大小，收到 ${String(contextWindow)}`)
  }

  const resolved: Partial<Record<LiveCompactThresholdField, number>> = {}
  for (const spec of LIVE_COMPACT_THRESHOLD_SPECS) {
    const override = overrides[spec.field]
    const raw = override ?? spec.resolve({ contextWindow, resolved })
    resolved[spec.field] = toThresholdValue(spec.field, raw)
  }

  const values = resolved as Record<LiveCompactThresholdField, number>
  assertThresholdInvariants(values)

  const env: Record<string, string> = {}
  for (const spec of LIVE_COMPACT_THRESHOLD_SPECS) {
    if (!spec.envKey) continue
    env[spec.envKey] = String(values[spec.field])
  }

  return { ...values, env }
}

/** 表内不变量：比例换算一旦被覆盖成不合理组合，宁可报错也不要发出错误 env。 */
function assertThresholdInvariants(values: Record<LiveCompactThresholdField, number>): void {
  if (values.keepRoundTokens > values.minPressureTokens) {
    throw new TypeError(
      `Live Compact 保留轮预算（${values.keepRoundTokens}）不应高于触发线（${values.minPressureTokens}）：` +
      '压后目标线高于触发线会让每次 drain 立即停止',
    )
  }
  if (values.minPressureTokens >= values.urgentTokens) {
    throw new TypeError(
      `Live Compact 触发线（${values.minPressureTokens}）必须低于紧急线（${values.urgentTokens}）`,
    )
  }
  if (values.urgentTokens >= values.bigGateTokens) {
    throw new TypeError(
      `Live Compact 紧急线（${values.urgentTokens}）必须低于停手线（${values.bigGateTokens}）`,
    )
  }
  if (values.chunkMinTokens > values.chunkMaxTokens) {
    throw new TypeError(
      `Live Compact 单段最小（${values.chunkMinTokens}）不能高于单段最大（${values.chunkMaxTokens}）`,
    )
  }
}

/** 便于日志与设置页展示：键 → 当前取值的紧凑描述。 */
export function describeLiveCompactThresholds(thresholds: LiveCompactThresholds): string {
  return LIVE_COMPACT_THRESHOLD_SPECS
    .map((spec) => `${spec.envKey ?? spec.field}=${thresholds[spec.field]}`)
    .join(' ')
}
