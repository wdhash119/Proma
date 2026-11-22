/**
 * 千问 Token Plan 订阅额度查询。
 *
 * 覆盖两类账号：
 * - 个人版：用 access token 派生 cs-data 专用 token，再查订阅与月度用量；
 * - 团队版：直接用 access token 调 BSS `GetSeatSubscriptionSummary`，读各席位 Credits。
 *
 * 约束：
 * - 只读取已知字段，其余上游字符串不会被当作展示文案；
 * - 一个版本失败不能抹掉另一个版本的成功结果；
 * - 派生凭证只驻留内存，按渠道缓存并按 access token 失效，最多重签一次；
 * - 错误只使用固定脱敏文案，不包含 token、派生凭证、响应正文或代理地址。
 */

import type {
  ChannelPlanQuotaResult,
  ChannelPlanQuotaWindow,
  QianwenPlanQuotaCredentials,
  ProviderType,
} from '@proma/shared'
import { isQianwenPlanQuotaCredentialExpired } from '@proma/shared'
import { createManagedProxyFetch } from './proxy-fetch'
import type { ManagedProxyFetch } from './proxy-fetch'
import {
  QIANWEN_CLI_API_URL,
  QIANWEN_CLI_USER_AGENT,
  QIANWEN_CORNERSTONE_PARAM,
  QIANWEN_GATEWAY_API_VERSION,
  QIANWEN_QUOTA_REQUEST_TIMEOUT_MS,
  QIANWEN_REGION,
  QIANWEN_SOLO_COMMODITY_CODE,
  QIANWEN_SOLO_SUBSCRIPTION_API,
  QIANWEN_SOLO_USAGE_API,
  QIANWEN_TEAM_COMMODITY_CODE,
  buildQianwenCsDataUrl,
} from './qianwen-api-routes'

type JsonRecord = Record<string, unknown>

/** 管理接口固定版本参数（与官方 CLI 一致）。 */
const QIANWEN_CLI_VERSION = '2026-02-10'
const QIANWEN_TEAM_ACTION = 'GetSeatSubscriptionSummary'
const QIANWEN_GENERATE_TOKEN_ACTION = 'GenerateCLIAccessToken'
const QIANWEN_GENERATE_TOKEN_PRODUCT = 'ModelStudioRegional'

const MESSAGES = {
  expiredLogin: '千问登录已过期，请重新登录',
  authFailed: '千问登录已失效，请重新登录',
  rateLimited: '千问额度查询过于频繁，请稍后重试',
  network: '千问额度查询失败，请检查网络或代理后重试',
  generic: '千问额度查询失败，请稍后重试',
  notSubscribed: '当前千问账号未订阅 Token Plan 个人版或团队版',
  partial: '部分千问额度暂不可用',
  soloResponse: '千问个人版额度响应异常',
  soloLogin: '千问个人版额度需要重新登录',
  teamResponse: '千问团队版额度响应异常',
  teamLogin: '千问团队版额度需要重新登录',
  teamPartial: '部分团队席位额度数据无法解析',
} as const

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeRecord(record: JsonRecord): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record)) map.set(normalizeKey(key), value)
  return map
}

/** 以广度优先顺序收集所有嵌套对象，便于容忍顶层或 Data 包裹两种响应形态。 */
function collectRecords(root: unknown): JsonRecord[] {
  const records: JsonRecord[] = []
  const queue: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }]
  while (queue.length > 0) {
    const { value, depth } = queue.shift()!
    if (depth > 8 || value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) queue.push({ value: item, depth: depth + 1 })
      continue
    }
    records.push(value as JsonRecord)
    for (const item of Object.values(value as JsonRecord)) {
      if (item !== null && typeof item === 'object') queue.push({ value: item, depth: depth + 1 })
    }
  }
  return records
}

function deepString(root: unknown, keys: readonly string[]): string | undefined {
  for (const record of collectRecords(root)) {
    const map = normalizeRecord(record)
    for (const key of keys) {
      const value = map.get(key)
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return undefined
}

/** 在任意层级的字符串值里查找登录失效标记；只影响控制流，不拼接错误文案。 */
function containsStringMarker(root: unknown, marker: string): boolean {
  return collectRecords(root).some((record) =>
    Object.values(record).some((value) => typeof value === 'string' && value.includes(marker)),
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 解析上游时间字段：接受秒/毫秒时间戳，或带 `Z`/时区偏移的 ISO 8601。
 *
 * 不接受无时区日期，也不把订阅 `EndTime` 之类的时间当作重置时间猜测。
 */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value < 1e12 ? Math.round(value * 1000) : value
  }
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw) return undefined
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000
  if (/^\d{13}$/.test(raw)) return Number(raw)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return undefined
  }
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function parseDecimal(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

// ===== cs-data envelope =====

type CsDataOutcome =
  | { kind: 'ok'; payload: JsonRecord }
  | { kind: 'not_logined' }
  | { kind: 'invalid' }

const NOT_LOGINED_MARKER = 'BailianGateway.Login.NotLogined'

/**
 * 按官方 `unwrapCsDataResponse` 顺序校验 cs-data 响应，HTTP 200 不代表业务成功：
 *
 * 1. 外层 `code === '200' && successResponse === true`；
 * 2. `data.success === true`，且存在 `errorCode` 时必须为空；
 * 3. `data.DataV2.ret[0]` 只校验以 `SUCCESS::` 开头（它不携带业务 JSON）；
 * 4. 业务 envelope 在 `data.DataV2.data`，再要求 `code === 'SUCCESS' && success === true`；
 * 5. 业务数据取 `business.data`；没有 `data` 键时视为空业务数据（无订阅）。
 */
function readCsDataEnvelope(value: unknown): CsDataOutcome {
  if (!isRecord(value)) return { kind: 'invalid' }
  const outer = normalizeRecord(value)
  const outerCode = outer.get('code')
  // 官方只接受字符串 '200'；兼容部分网关的数字形式。
  if (outerCode !== '200' && outerCode !== 200) return { kind: 'invalid' }
  if (outer.get('successresponse') !== true) return { kind: 'invalid' }

  const data = outer.get('data')
  if (!isRecord(data)) return { kind: 'invalid' }
  const inner = normalizeRecord(data)
  const errorCode = inner.get('errorcode')
  if (inner.get('success') === false && errorCode === NOT_LOGINED_MARKER) {
    return { kind: 'not_logined' }
  }
  if (inner.get('success') !== true) return { kind: 'invalid' }
  if (typeof errorCode === 'string' && errorCode !== '') return { kind: 'invalid' }

  const dataV2 = inner.get('datav2')
  if (!isRecord(dataV2)) return { kind: 'invalid' }
  const dataV2Fields = normalizeRecord(dataV2)
  const ret = dataV2Fields.get('ret')
  if (!Array.isArray(ret) || typeof ret[0] !== 'string' || !ret[0].startsWith('SUCCESS::')) {
    return { kind: 'invalid' }
  }

  const business = dataV2Fields.get('data')
  if (!isRecord(business)) return { kind: 'invalid' }
  const businessFields = normalizeRecord(business)
  if (businessFields.get('code') !== 'SUCCESS' || businessFields.get('success') !== true) {
    return { kind: 'invalid' }
  }

  const payload = businessFields.get('data')
  return { kind: 'ok', payload: isRecord(payload) ? payload : {} }
}

// ===== 个人版 =====

/**
 * 档位来源字段：官方只认 `specCode`；其余为旧接口/其他网关的兼容名。
 */
/** 官方 specCode 白名单：只做精确匹配，未知值不猜档位。 */
const SOLO_TIER_BY_SPEC_CODE: ReadonlyMap<string, string> = new Map([
  ['lite', 'Lite'],
  ['essential', 'Essential'],
  ['standard', 'Standard'],
  ['pro', 'Pro'],
])

/** 旧接口/其他网关的档位字段：按完整单词匹配，避免 professional 被当成 Pro。 */
const LEGACY_SOLO_TIER_KEYS = ['spectype', 'plantype', 'planname', 'subscriptiontype'] as const

function matchesTierWord(value: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value)
}

function soloTierLabel(payload: JsonRecord): string | undefined {
  const map = normalizeRecord(payload)
  const specCode = map.get('speccode')
  if (typeof specCode === 'string' && specCode.trim()) {
    // specCode 是官方字段：不在白名单就不猜（professional 等新值不会归为 Pro）。
    return SOLO_TIER_BY_SPEC_CODE.get(specCode.trim().toLowerCase())
  }
  for (const key of LEGACY_SOLO_TIER_KEYS) {
    const value = map.get(key)
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (!normalized) continue
    if (matchesTierWord(normalized, 'lite')) return 'Lite'
    if (matchesTierWord(normalized, 'essential')) return 'Essential'
    if (matchesTierWord(normalized, 'standard')) return 'Standard'
    if (matchesTierWord(normalized, 'pro')) return 'Pro'
  }
  return undefined
}

/** 只读取 0..1 的有限数字；字符串、越界与 NaN 一律不采信。 */
function soloMonthlyRatio(payload: JsonRecord | undefined): number | undefined {
  if (!payload) return undefined
  const value = normalizeRecord(payload).get('per1monthpercentage')
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

export interface QianwenPersonalQuota {
  planName?: string
  windows: ChannelPlanQuotaWindow[]
  message?: string
}

/**
 * 解析个人版订阅与月度用量。
 *
 * 关键约束：
 * - `commodityCode` 必须是个人版商品码，`status` 必须是 VALID，且当前时间落在订阅窗口内；
 * - 只有 monthly 数据会生成窗口，遗留 weekly 不会被冒充为月度额度；
 * - 订阅窗口或用量 envelope 异常时只返回固定脱敏提示。
 */
export function parseQianwenPersonalQuota(input: {
  subscription: unknown
  usage: unknown
  now?: number
}): QianwenPersonalQuota {
  const now = input.now ?? Date.now()
  const subscription = readCsDataEnvelope(input.subscription)
  if (subscription.kind === 'not_logined') return { windows: [], message: MESSAGES.soloLogin }
  if (subscription.kind === 'invalid') return { windows: [], message: MESSAGES.soloResponse }

  const usage = readCsDataEnvelope(input.usage)
  if (usage.kind === 'not_logined') return { windows: [], message: MESSAGES.soloLogin }
  if (usage.kind === 'invalid') return { windows: [], message: MESSAGES.soloResponse }

  return parsePersonalPayloads(subscription.payload, usage.payload, now)
}

/** 已通过 envelope 校验后的业务数据解析；查询路径复用同一函数，避免两份逻辑。 */
function parsePersonalPayloads(
  subscription: JsonRecord,
  usage: JsonRecord,
  now: number,
): QianwenPersonalQuota {
  const commodityCode = deepString(subscription, ['commoditycode'])
  // 官方 `parseSoloSubscription` 只在字段存在时校验商品码；真实响应通常不返回它。
  if (commodityCode !== undefined && commodityCode !== QIANWEN_SOLO_COMMODITY_CODE) {
    // 明确是其他商品：不是个人版 Token Plan，也不生成空窗口。
    return { windows: [] }
  }

  const status = deepString(subscription, ['status'])
  if (!status || status.toLowerCase() !== 'valid') return { windows: [] }

  const startAt = parseTimestamp(normalizeRecord(subscription).get('starttime'))
  const endAt = parseTimestamp(normalizeRecord(subscription).get('endtime'))
  // 无法确认有效期时不展示，避免把过期账号的旧用量当成有效额度。
  if (startAt === undefined || endAt === undefined) return { windows: [] }
  if (now < startAt || now >= endAt) return { windows: [] }

  const ratio = soloMonthlyRatio(usage) ?? soloMonthlyRatio(subscription)
  if (ratio === undefined) return { windows: [] }

  const usedPercent = round2(ratio * 100)
  const remainingPercent = round2(100 - usedPercent)
  const resetAt = parseTimestamp(normalizeRecord(usage).get('per1monthresettime'))
    ?? parseTimestamp(normalizeRecord(subscription).get('per1monthresettime'))

  const tier = soloTierLabel(subscription)
  return {
    planName: tier ? `千问 Token Plan 个人版 ${tier}` : '千问 Token Plan 个人版',
    windows: [{
      type: 'custom',
      label: '个人版本月',
      remainingPercent,
      usedPercent,
      showProgress: true,
      ...(resetAt !== undefined ? { resetAt } : {}),
    }],
  }
}

// ===== 团队版 =====

const TEAM_SPEC_LABELS = {
  standard: 'Standard',
  pro: 'Pro',
  max: 'Max',
} as const

type TeamSpecType = keyof typeof TEAM_SPEC_LABELS

function isTeamSpecType(value: string): value is TeamSpecType {
  return value === 'standard' || value === 'pro' || value === 'max'
}

interface TeamGroupResult {
  specType: TeamSpecType
  window: ChannelPlanQuotaWindow
}

const TEAM_UNIT_KEYS = ['unit', 'unitname'] as const
const TEAM_TOTAL_KEYS = ['totalvalue'] as const
const TEAM_SURPLUS_KEYS = ['surplusvalue'] as const

/** 某个显式单位声明是否不是 Credits；undefined/缺失视为未声明。 */
function hasNonCreditsUnit(record: Map<string, unknown>): boolean {
  return TEAM_UNIT_KEYS.some((key) => {
    const unit = record.get(key)
    if (unit === undefined || unit === null) return false
    return !(typeof unit === 'string' && unit.trim().toLowerCase() === 'credits')
  })
}

/**
 * 单个席位组：唯一 CREDITS 权益、单位一致、可安全转换的十进制总量/余量。
 *
 * `NextCycleFlushTime` 在席位组上，不在 CREDITS 权益上（官方 `extractSeatTiers` / `betTeamSeatGroups`）。
 */
function parseTeamGroup(value: unknown): ChannelPlanQuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const group = normalizeRecord(value)
  const specRaw = group.get('spectype')
  if (typeof specRaw !== 'string') return undefined
  const specType = specRaw.trim().toLowerCase()
  if (!isTeamSpecType(specType)) return undefined

  const equityList = group.get('equitylist')
  if (!Array.isArray(equityList)) return undefined
  const credits = equityList.filter((item) => {
    if (!isRecord(item)) return false
    const equityType = normalizeRecord(item).get('equitytype')
    return typeof equityType === 'string' && equityType.trim().toUpperCase() === 'CREDITS'
  })
  // 缺权益或多个 Credits 权益都无法确定用哪一个，跳过而不是猜测。
  if (credits.length !== 1) return undefined

  const equity = normalizeRecord(credits[0] as JsonRecord)
  // 官方：right.Unit / right.UnitName / group.Unit / group.UnitName 任一显式存在且不是 credits 就拒绝。
  if (hasNonCreditsUnit(equity) || hasNonCreditsUnit(group)) return undefined

  const readDecimal = (keys: readonly string[]): number | undefined => {
    for (const key of keys) {
      const parsed = parseDecimal(equity.get(key))
      if (parsed !== undefined) return parsed
    }
    return undefined
  }
  const total = readDecimal(TEAM_TOTAL_KEYS)
  const remaining = readDecimal(TEAM_SURPLUS_KEYS)
  if (total === undefined || remaining === undefined) return undefined
  if (total <= 0 || remaining < 0 || remaining > total) return undefined

  const remainingPercent = round2(remaining / total * 100)
  const usedPercent = round2(100 - remainingPercent)
  const resetAt = parseTimestamp(group.get('nextcycleflushtime'))

  return {
    type: 'custom',
    label: `团队 ${TEAM_SPEC_LABELS[specType]}`,
    remainingPercent,
    usedPercent,
    showProgress: true,
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

export interface QianwenTeamQuota {
  windows: ChannelPlanQuotaWindow[]
  message?: string
}

interface TeamEnvelopeCheck {
  ok: boolean
  /** 外层与 Data 内都未声明失败时的业务对象。 */
  inner?: Map<string, unknown>
}

/**
 * 官方 `teamResponseData` 的严格版本：`Success` 存在时必须为 true，`Code` 存在时必须为 `Success`。
 *
 * `allowHttpCode` 只用于最外层传输信封：那里可能用 `code: '200'` 表示 HTTP 成功，
 * 它不代替业务 `Code`；业务对象（Data 内或 flat 根）必须严格为 `Success`。
 */
function checkTeamEnvelope(record: Map<string, unknown>, allowHttpCode = false): boolean {
  const success = record.get('success')
  if (success !== undefined && success !== true) return false
  const code = record.get('code')
  if (code === undefined || code === 'Success') return true
  return allowHttpCode && code === '200'
}

function readTeamEnvelope(value: unknown): TeamEnvelopeCheck {
  if (!isRecord(value)) return { ok: false }
  const raw = normalizeRecord(value)
  const dataField = raw.get('data')
  const wrapped = isRecord(dataField)
  // 只有明确带 Data 包裹时才把最外层的 `code: '200'` 当作 HTTP 状态；
  // flat 响应的根对象就是业务对象，必须严格为 Success。
  if (!checkTeamEnvelope(raw, wrapped)) return { ok: false }

  const inner = wrapped ? normalizeRecord(dataField) : raw
  if (inner !== raw && !checkTeamEnvelope(inner)) return { ok: false }

  const productCode = inner.get('productcode')
  // 官方在 inner.ProductCode 存在时不匹配即视为 InvalidResponse（接口漂移），不当“未订阅”。
  if (typeof productCode === 'string' && productCode !== QIANWEN_TEAM_COMMODITY_CODE) {
    return { ok: false }
  }
  return { ok: true, inner }
}

/**
 * 解析团队版 `GetSeatSubscriptionSummary`。
 *
 * 只处理 standard / pro / max 三种席位；同一 SpecType 出现多个组时加序号分别展示，
 * 不做浮点求和（避免展示不准确的总量）。
 */
export function parseQianwenTeamQuota(value: unknown): QianwenTeamQuota {
  if (!isRecord(value)) return { windows: [], message: MESSAGES.teamResponse }
  if (containsStringMarker(value, 'ConsoleNeedLogin')) {
    return { windows: [], message: MESSAGES.teamLogin }
  }

  const envelope = readTeamEnvelope(value)
  if (!envelope.ok || !envelope.inner) return { windows: [], message: MESSAGES.teamResponse }

  const groups = envelope.inner.get('subscriptiongrouplist')
  if (!Array.isArray(groups)) {
    // 官方：没有组列表但业务对象非空 → MissingGroups（响应异常）。
    if (envelope.inner.size === 0) return { windows: [] }
    return { windows: [], message: MESSAGES.teamResponse }
  }
  if (groups.length === 0) return { windows: [] }

  const accepted: TeamGroupResult[] = []
  let skippedKnownSpec = false
  for (const group of groups) {
    if (!isRecord(group)) {
      skippedKnownSpec = true
      continue
    }
    const specRaw = normalizeRecord(group).get('spectype')
    if (typeof specRaw !== 'string' || !specRaw.trim()) {
      skippedKnownSpec = true
      continue
    }
    const specType = specRaw.trim().toLowerCase()
    // 未知 SpecType 不生成任意上游标签，也不计入“部分失败”。
    if (!isTeamSpecType(specType)) continue

    const window = parseTeamGroup(group)
    if (!window) {
      skippedKnownSpec = true
      continue
    }
    accepted.push({ specType, window })
  }

  const countBySpec = new Map<TeamSpecType, number>()
  for (const { specType } of accepted) {
    countBySpec.set(specType, (countBySpec.get(specType) ?? 0) + 1)
  }
  const indexBySpec = new Map<TeamSpecType, number>()
  const windows = accepted.map(({ specType, window }) => {
    if ((countBySpec.get(specType) ?? 0) <= 1) return window
    const nextIndex = (indexBySpec.get(specType) ?? 0) + 1
    indexBySpec.set(specType, nextIndex)
    return { ...window, label: `${window.label} ${nextIndex}` }
  })

  if (skippedKnownSpec) return { windows, message: MESSAGES.teamPartial }
  return { windows }
}

// ===== 查询 =====

type QuotaFailure = 'auth' | 'rate' | 'network' | 'server' | 'format'

class QuotaRequestError extends Error {
  constructor(readonly failure: QuotaFailure) {
    super(failure)
  }
}

interface JsonResponse {
  status: number
  body: unknown
}

function failureForStatus(status: number): QuotaFailure | undefined {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return undefined
}

/** 单次管理接口请求参数；不同的管理接口使用不同 content-type 与 body 形态。 */
interface JsonRequestInput {
  /** Bearer 凭据；缺省时不发送 Authorization。 */
  bearer?: string
  contentType: string
  body: string
}

/** 单次管理接口请求；每个查询周期只 create 一次 transport，由调用方统一 close。 */
async function requestJson(
  transport: ManagedProxyFetch,
  url: string,
  input: JsonRequestInput,
): Promise<JsonResponse> {
  let response: Response
  try {
    response = await transport.fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...(input.bearer ? { Authorization: `Bearer ${input.bearer}` } : {}),
        'Content-Type': input.contentType,
        Accept: 'application/json',
        'User-Agent': QIANWEN_CLI_USER_AGENT,
      },
      body: input.body,
      signal: AbortSignal.timeout(QIANWEN_QUOTA_REQUEST_TIMEOUT_MS),
    })
  } catch {
    // 不返回/记录底层网络异常：URL 与请求头都可能带凭据；超时与断网对用户是同一处置。
    throw new QuotaRequestError('network')
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    try { await response.body?.cancel() } catch { /* 正文已失败，取消失败无副作用。 */ }
    throw new QuotaRequestError('network')
  }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    throw new QuotaRequestError('format')
  }
}

/**
 * 按渠道缓存派生凭证；access token 变化或上游判定未登录时立即失效。
 *
 * inflight 与 cache 都按 channelId 索引：写入方必须在完成时确认自己仍是当前 inflight，
 * 否则「删除渠道」「access 换号」后晚到的旧结果不得复活缓存或覆盖新账号凭证。
 */
const derivedTokenCache = new Map<string, { access: string; cliAccessToken: string }>()
const derivedTokenInflight = new Map<string, { access: string; promise: Promise<string> }>()

/**
 * 清除某个渠道的派生凭证（内存态）。
 *
 * 删除渠道时必须调用：否则 access token 会留在进程内存里直到退出，
 * 同名 channelId 复用时也可能误用旧凭证。
 */
export function invalidateQianwenDerivedToken(channelId: string): void {
  derivedTokenCache.delete(channelId)
  derivedTokenInflight.delete(channelId)
}

/**
 * 读取 `GenerateCLIAccessToken` 的 flat 响应。
 *
 * 官方直接检查 `cliAccessToken`；这里同时容忍明确的一层 `Data` 包裹，
 * 但不会套用 cs-data 的 DataV2 envelope（两者是不同的接口形态）。
 */
function parseCliAccessTokenResponse(body: unknown, accessToken: string): string {
  if (containsStringMarker(body, 'ConsoleNeedLogin')) throw new QuotaRequestError('auth')
  const token = deepString(body, ['cliaccesstoken'])
  // 派生凭证必须是非空且不同于账号 access token 的字符串。
  if (!token || token === accessToken) throw new QuotaRequestError('format')
  return token
}

async function requestCliAccessToken(
  transport: ManagedProxyFetch,
  credentials: QianwenPlanQuotaCredentials,
): Promise<string> {
  const response = await requestJson(transport, QIANWEN_CLI_API_URL, {
    bearer: credentials.access,
    contentType: 'application/json',
    body: JSON.stringify({
      product: QIANWEN_GENERATE_TOKEN_PRODUCT,
      action: QIANWEN_GENERATE_TOKEN_ACTION,
      version: QIANWEN_CLI_VERSION,
      region: QIANWEN_REGION,
      params: {},
    }),
  })
  const statusFailure = failureForStatus(response.status)
  if (statusFailure) throw new QuotaRequestError(statusFailure)
  if (response.status !== 200) throw new QuotaRequestError('server')
  return parseCliAccessTokenResponse(response.body, credentials.access)
}

interface CliAccessTokenResult {
  token: string
  /** 本次调用是否实际发起（或加入）了一次签发；缓存命中为 false。 */
  fresh: boolean
}

async function resolveCliAccessToken(
  transport: ManagedProxyFetch,
  channelId: string,
  credentials: QianwenPlanQuotaCredentials,
): Promise<CliAccessTokenResult> {
  const cached = derivedTokenCache.get(channelId)
  if (cached && cached.access === credentials.access) {
    return { token: cached.cliAccessToken, fresh: false }
  }

  const inflight = derivedTokenInflight.get(channelId)
  if (inflight && inflight.access === credentials.access) {
    return { token: await inflight.promise, fresh: true }
  }

  const promise = requestCliAccessToken(transport, credentials)
    .then((cliAccessToken) => {
      // 只有当前 inflight 仍指向本 promise 时才允许写缓存：渠道已删除或 access 已换号时，
      // 晚到的旧签发结果必须直接丢弃，不能复活缓存、也不能覆盖新凭证。
      if (derivedTokenInflight.get(channelId)?.promise === promise) {
        derivedTokenCache.set(channelId, { access: credentials.access, cliAccessToken })
      }
      return cliAccessToken
    })
    .finally(() => {
      if (derivedTokenInflight.get(channelId)?.promise === promise) derivedTokenInflight.delete(channelId)
    })
  derivedTokenInflight.set(channelId, { access: credentials.access, promise })
  return { token: await promise, fresh: true }
}

type CsDataCall = { kind: 'ok'; payload: JsonRecord } | { kind: 'not_logined' } | { kind: 'invalid' }

async function postCsData(
  transport: ManagedProxyFetch,
  cliAccessToken: string,
  api: string,
  businessData: JsonRecord,
): Promise<CsDataCall> {
  // 官方 buildCsDataRequest：业务参数与 cornerstoneParam 一起序列化进 params.Data。
  const params = {
    Api: api,
    V: QIANWEN_GATEWAY_API_VERSION,
    Data: { ...businessData, cornerstoneParam: QIANWEN_CORNERSTONE_PARAM },
  }
  const response = await requestJson(transport, buildQianwenCsDataUrl(api), {
    bearer: cliAccessToken,
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({ params: JSON.stringify(params), region: QIANWEN_REGION }).toString(),
  })
  const statusFailure = failureForStatus(response.status)
  if (statusFailure) throw new QuotaRequestError(statusFailure)
  if (response.status !== 200) throw new QuotaRequestError('server')
  return readCsDataEnvelope(response.body)
}

interface VersionQuota {
  planName?: string
  windows: ChannelPlanQuotaWindow[]
  failure?: QuotaFailure
}

function asVersionQuota(result: QianwenPersonalQuota): VersionQuota {
  return { windows: result.windows, ...(result.planName ? { planName: result.planName } : {}) }
}

/** 个人版：先派生凭证，再查订阅与用量；仅 NotLogined 允许重签一次。 */
async function queryPersonalVersion(
  transport: ManagedProxyFetch,
  channelId: string,
  credentials: QianwenPlanQuotaCredentials,
  now: number,
): Promise<VersionQuota> {
  try {
    const resolved = await resolveCliAccessToken(transport, channelId, credentials)
    let subscription = await postCsData(
      transport,
      resolved.token,
      QIANWEN_SOLO_SUBSCRIPTION_API,
      // 官方订阅接口白名单：业务参数只能有 commodityCode。
      { commodityCode: QIANWEN_SOLO_COMMODITY_CODE },
    )
    let usage = await postCsData(transport, resolved.token, QIANWEN_SOLO_USAGE_API, {})

    const notLogined = (): boolean =>
      subscription.kind === 'not_logined' || usage.kind === 'not_logined'

    if (notLogined()) {
      // 刚签发的凭证第一次就被判定未登录：上游不接受当前登录，重签没有意义，直接要求重新登录。
      if (resolved.fresh) return { windows: [], failure: 'auth' }

      // 只有缓存凭证被上游提前失效时才重签一次；重签后仍失败就停止。
      invalidateQianwenDerivedToken(channelId)
      const renewed = await resolveCliAccessToken(transport, channelId, credentials)
      if (subscription.kind === 'not_logined') {
        subscription = await postCsData(
          transport,
          renewed.token,
          QIANWEN_SOLO_SUBSCRIPTION_API,
          { commodityCode: QIANWEN_SOLO_COMMODITY_CODE },
        )
      }
      if (usage.kind === 'not_logined') {
        usage = await postCsData(transport, renewed.token, QIANWEN_SOLO_USAGE_API, {})
      }
      if (notLogined()) return { windows: [], failure: 'auth' }
    }

    // 复用解析器：业务数据已通过 envelope 校验，直接解析 payload。
    if (subscription.kind !== 'ok' || usage.kind !== 'ok') return { windows: [], failure: 'format' }
    const parsed = parsePersonalPayloads(subscription.payload, usage.payload, now)
    return asVersionQuota(parsed)
  } catch (error) {
    return { windows: [], failure: error instanceof QuotaRequestError ? error.failure : 'network' }
  }
}

/** 团队版：直接用账号 access token，不依赖派生凭证。 */
async function queryTeamVersion(
  transport: ManagedProxyFetch,
  credentials: QianwenPlanQuotaCredentials,
): Promise<VersionQuota> {
  try {
    const response = await requestJson(transport, QIANWEN_CLI_API_URL, {
      bearer: credentials.access,
      contentType: 'application/json',
      body: JSON.stringify({
        product: 'BssOpenAPI-V3',
        action: QIANWEN_TEAM_ACTION,
        region: QIANWEN_REGION,
        params: { productCode: QIANWEN_TEAM_COMMODITY_CODE },
      }),
    })
    const statusFailure = failureForStatus(response.status)
    if (statusFailure) return { windows: [], failure: statusFailure }
    if (response.status !== 200) return { windows: [], failure: 'server' }

    const parsed = parseQianwenTeamQuota(response.body)
    if (parsed.windows.length === 0) {
      if (parsed.message === MESSAGES.teamLogin) return { windows: [], failure: 'auth' }
      // ProductCode 不匹配属于响应异常/接口漂移，会以 teamResponse 走到这里。
      if (parsed.message === MESSAGES.teamResponse) return { windows: [], failure: 'format' }
      // 空的组列表只表示该账号没有可展示的团队额度，不是查询失败。
      return { windows: [] }
    }
    // 部分组无法解析时仍展示合法组，并让上层附加「部分不可用」提示。
    return {
      windows: parsed.windows,
      ...(parsed.message === MESSAGES.teamPartial ? { failure: 'format' as const } : {}),
    }
  } catch (error) {
    return { windows: [], failure: error instanceof QuotaRequestError ? error.failure : 'network' }
  }
}

function unavailable(provider: ProviderType, message: string): ChannelPlanQuotaResult {
  return { supported: false, provider, windows: [], updatedAt: Date.now(), message }
}

function failureMessage(failures: QuotaFailure[]): string {
  if (failures.includes('auth')) return MESSAGES.authFailed
  if (failures.includes('rate')) return MESSAGES.rateLimited
  if (failures.includes('network')) return MESSAGES.network
  if (failures.includes('server')) return MESSAGES.network
  if (failures.includes('format')) return MESSAGES.generic
  return MESSAGES.notSubscribed
}

/**
 * 查询千问 Token Plan 额度。
 *
 * 个人版与团队版独立查询；一个版本失败时仍返回另一个版本的成功窗口，并附加
 * 脱敏的「部分不可用」提示。access token 过期时零请求，直接提示重新登录。
 */
export async function queryQianwenPlanQuota(
  channelId: string,
  provider: 'qianwen-token-plan' | 'qianwen-token-plan-openai',
  credentials: QianwenPlanQuotaCredentials,
  proxyUrl?: string,
  createTransport: typeof createManagedProxyFetch = createManagedProxyFetch,
): Promise<ChannelPlanQuotaResult> {
  if (isQianwenPlanQuotaCredentialExpired(credentials)) {
    return unavailable(provider, MESSAGES.expiredLogin)
  }

  let transport: ManagedProxyFetch | undefined
  try {
    transport = createTransport(proxyUrl)
    const now = Date.now()
    const [personal, team] = await Promise.all([
      queryPersonalVersion(transport, channelId, credentials, now),
      queryTeamVersion(transport, credentials),
    ])

    const windows = [...personal.windows, ...team.windows]
    const failures = [personal.failure, team.failure].filter((failure): failure is QuotaFailure => failure !== undefined)

    if (windows.length === 0) {
      return unavailable(provider, failureMessage(failures))
    }

    const planName = personal.windows.length > 0 && team.windows.length > 0
      ? '千问 Token Plan（个人版 + 团队版）'
      : personal.windows.length > 0
        ? personal.planName ?? '千问 Token Plan 个人版'
        : '千问 Token Plan 团队版'

    return {
      supported: true,
      provider,
      planName,
      windows,
      updatedAt: Date.now(),
      ...(failures.length > 0 ? { message: MESSAGES.partial } : {}),
    }
  } catch {
    // 兜底：任何未预期异常都不得把内部错误或凭据带出主进程。
    return unavailable(provider, MESSAGES.generic)
  } finally {
    try { await transport?.close() } catch { /* 关闭失败不影响查询结果。 */ }
  }
}
