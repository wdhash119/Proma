/**
 * 千问账号登录服务（device-code + PKCE）。
 *
 * 对齐官方 qianwen-cli v1.12.0：
 * - `client_id` 是 Proma 自己生成并持久化的随机 UUID，不需要注册应用或 client_secret；
 * - PKCE verifier 每次登录随机生成，challenge 为 SHA-256 base64url；
 * - 先用 device code 换用户授权链接，再按 interval 轮询 token；
 * - 成功响应只保留 access token 与过期时间。
 *
 * 这里**不实现 refresh**：官方 CLI 没有可复用的续期流程，token 过期只能让用户重新登录。
 * 该凭据只用于查询订阅额度，不参与模型推理，也不会写入 Channel.apiKey。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import type { QianwenOAuthDeviceCode, QianwenPlanQuotaCredentials } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { createManagedProxyFetch } from './proxy-fetch'
import type { ManagedProxyFetch } from './proxy-fetch'
import { writeJsonFileAtomic } from './safe-file'
import {
  QIANWEN_AUTH_REQUEST_TIMEOUT_MS,
  QIANWEN_CLI_USER_AGENT,
  QIANWEN_DEVICE_CODE_URL,
  QIANWEN_DEVICE_TOKEN_URL,
  isQianwenVerificationUri,
} from './qianwen-api-routes'

/** 设备授权 client ID 的文件名（位于 Proma 配置目录）。 */
const DEVICE_CLIENT_FILE = 'qianwen-device.json'

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_EXPIRES_IN_SECONDS = 300
const DEFAULT_INTERVAL_SECONDS = 2
/** 收到 slow_down 后间隔增加 5 秒，并用于后续全部轮询。 */
const SLOW_DOWN_INCREMENT_MS = 5_000

/**
 * 固定文案：错误与日志都不得包含 access token、device token、PKCE verifier、
 * 完整授权 URL 或代理地址，因此所有对外错误只使用这些常量。
 */
const MESSAGES = {
  cancelled: '千问登录已取消',
  network: '千问登录请求失败，请检查网络或代理后重试',
  timeout: '千问授权请求超时，请检查网络或代理后重试',
  invalidResponse: '千问授权服务响应格式错误',
  emptyResponse: '千问授权服务返回空响应',
  invalidDeviceCode: '千问授权服务未返回有效的设备码',
  untrustedVerificationUri: '千问授权地址不在受信任域名下，已取消登录',
  denied: '千问授权已被拒绝或取消',
  expired: '千问授权已过期，请重新登录',
  deadline: '千问授权已超时，请重新登录',
  failed: '千问授权失败，请稍后重试',
  missingCredentials: '千问授权响应缺少有效的访问令牌',
  missingExpiry: '千问授权响应缺少有效的过期时间',
} as const

const SANITIZED_MESSAGES: ReadonlySet<string> = new Set(Object.values(MESSAGES))

/**
 * 登录失败统一脱敏：只放行本服务定义的固定文案。
 *
 * clientId 写文件失败、代理解析异常等非预期错误可能携带本地路径或内部信息，
 * 一律替换为固定文案，IPC 层也不得回显原始异常。
 */
export function sanitizeQianwenLoginError(error: unknown): string {
  return error instanceof Error && SANITIZED_MESSAGES.has(error.message)
    ? error.message
    : MESSAGES.failed
}

export interface QianwenLoginOptions {
  /** device code 就绪后回调（先于打开浏览器），用于向渲染层展示授权链接。 */
  onDeviceCode?: (deviceCode: QianwenOAuthDeviceCode) => void
}

export interface QianwenOAuthDependencies {
  createTransport?: typeof createManagedProxyFetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  openExternal?: (url: string) => Promise<void>
  now?: () => number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 归一化 JSON key：忽略大小写与分隔符，兼容 AccessToken / access_token 两种命名。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeRecord(record: JsonRecord): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record)) map.set(normalizeKey(key), value)
  return map
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

interface JsonIndex {
  strings: Map<string, string[]>
  numbers: Map<string, number[]>
}

/**
 * 深度索引响应中的字符串与数字字段。
 *
 * 千问内部网关的 envelope 层级不稳定（顶层直出或 Data 包裹），但字段名固定；
 * 按归一化字段名取首个命中值，比硬编码层级更稳。仅用于解析已知字段，
 * 任何未知字段都不会被当作展示文案。
 */
function indexJson(root: unknown): JsonIndex {
  const index: JsonIndex = { strings: new Map(), numbers: new Map() }
  const push = <T>(target: Map<string, T[]>, key: string, value: T): void => {
    const list = target.get(key)
    if (list) list.push(value)
    else target.set(key, [value])
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      const normalized = normalizeKey(key)
      if (typeof item === 'string' && item.trim()) {
        push(index.strings, normalized, item.trim())
      } else if (typeof item === 'number' && Number.isFinite(item)) {
        push(index.numbers, normalized, item)
      } else {
        visit(item, depth + 1)
      }
    }
  }
  visit(root, 0)
  return index
}

function firstString(index: JsonIndex, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = index.strings.get(key)?.[0]
    if (value) return value
  }
  return undefined
}

function firstNumber(index: JsonIndex, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = index.numbers.get(key)?.[0]
    if (value !== undefined) return value
    const text = index.strings.get(key)?.[0]
    if (text !== undefined) {
      const parsed = Number(text)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 收集所有字符串值，用于识别 pending / slow_down 等状态标记。 */
function allStrings(index: JsonIndex): string[] {
  const values: string[] = []
  for (const list of index.strings.values()) values.push(...list)
  return values
}

interface DeviceCodeInfo {
  /** 后续轮询使用的 device token。 */
  token: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * 解析设备码响应。
 *
 * 官方 `postDeviceCode` 的真实结构是 `{ Success: true, Data: { Token, VerificationUrl, ExpiresIn, Interval } }`；
 * 先按 `Data` 解析，再兼容旧式 `DeviceCode` 字段名。绝不把“响应里任意 URL”当作授权地址。
 */
function parseDeviceCode(data: unknown): DeviceCodeInfo | undefined {
  if (!isRecord(data)) return undefined
  const root = normalizeRecord(data)
  const success = root.get('success')
  if (success !== undefined && success !== true) return undefined

  const payload = root.get('data')
  const candidates: JsonRecord[] = []
  if (isRecord(payload)) candidates.push(payload)
  candidates.push(data)

  for (const candidate of candidates) {
    const map = normalizeRecord(candidate)
    const token = readString(map.get('token'))
      ?? readString(map.get('devicecode'))
      ?? readString(map.get('devicetoken'))
    const verificationUri = readString(map.get('verificationurl'))
      ?? readString(map.get('verificationuri'))
      ?? readString(map.get('verificationuricomplete'))
    if (!token || !verificationUri) continue

    return {
      token,
      verificationUri,
      expiresInSeconds: positiveSeconds(readNumber(map.get('expiresin')), DEFAULT_EXPIRES_IN_SECONDS),
      intervalSeconds: positiveSeconds(readNumber(map.get('interval')), DEFAULT_INTERVAL_SECONDS),
    }
  }
  return undefined
}

type TokenPollOutcome = 'success' | 'pending' | 'slow_down' | 'denied' | 'expired' | 'unknown'

/** 识别 device token 轮询结果；只有出现 access token 才算业务成功。 */
function classifyTokenResponse(body: unknown): TokenPollOutcome {
  const index = indexJson(body)
  // 只认显式 accessToken：轮询响应可能回显 device token，把通用 `token` 当成功会误判。
  if (firstString(index, ['accesstoken'])) return 'success'

  const markers = allStrings(index).map((value) => value.toLowerCase().replace(/[^a-z]/g, ''))
  const includesAny = (...candidates: string[]): boolean =>
    markers.some((marker) => candidates.some((candidate) => marker.includes(candidate)))

  if (includesAny('slowdown')) return 'slow_down'
  if (includesAny('accessdenied', 'denied', 'cancelled', 'canceled')) return 'denied'
  if (includesAny('expiredtoken', 'expired')) return 'expired'
  if (includesAny('authorizationpending', 'pending')) return 'pending'
  return 'unknown'
}

/**
 * 严格解析 ISO 8601 过期时间（必须带 `Z` 或时区偏移）。
 *
 * 不接受无时区日期：按本地时区解释会随用户机器变化，从而让 token 在错误时刻失效。
 */
function parseExpireTime(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    // 上游若给秒级时间戳（< 1e12），换成毫秒；其余按毫秒处理。
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
  if (!pattern.test(raw)) return undefined
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function parseTokenCredentials(body: unknown, now: number): QianwenPlanQuotaCredentials | undefined {
  const index = indexJson(body)
  const access = firstString(index, ['accesstoken'])
  if (!access) return undefined

  const expireTime = parseExpireTime(
    firstString(index, ['expiretime', 'expiresat', 'expireat'])
      ?? firstNumber(index, ['expiretime', 'expiresat', 'expireat']),
  )
  if (expireTime === undefined || expireTime <= now) return undefined

  const accountId = firstString(index, ['aliyunid', 'accountid', 'userid', 'uid'])
  return {
    access,
    expires: expireTime,
    ...(accountId ? { accountId } : {}),
  }
}

/**
 * 读取或创建本机 device client ID。
 *
 * 文件只保存 `{ clientId }`；内容非法（手工篡改、截断）时重建，不阻塞登录。
 */
export function readOrCreateQianwenClientId(configDir: string = getConfigDir()): string {
  const filePath = join(configDir, DEVICE_CLIENT_FILE)
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
      if (isRecord(parsed)) {
        const clientId = parsed.clientId
        if (typeof clientId === 'string' && CLIENT_ID_PATTERN.test(clientId)) return clientId
      }
      console.warn('[千问登录] 设备标识文件格式无效，已重新生成')
    }
  } catch {
    console.warn('[千问登录] 设备标识文件无法读取，已重新生成')
  }

  const clientId = randomUUID()
  writeJsonFileAtomic(filePath, { clientId })
  return clientId
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(MESSAGES.cancelled))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(MESSAGES.cancelled))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

interface JsonResponse {
  status: number
  body: unknown
}

/**
 * 发送一次 JSON 请求。
 *
 * 只返回解析后的 body：device token 轮询里 HTTP 4xx 也可能携带 pending / slow_down
 * 状态，必须由调用方先分类，而不是在这里当失败抛出。
 */
async function requestJson(
  transport: ManagedProxyFetch,
  url: string,
  signal: AbortSignal,
): Promise<JsonResponse> {
  let response: Response
  try {
    response = await transport.fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': QIANWEN_CLI_USER_AGENT,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(QIANWEN_AUTH_REQUEST_TIMEOUT_MS)]),
    })
  } catch (error) {
    if (signal.aborted) throw new Error(MESSAGES.cancelled)
    if (isTimeoutError(error)) throw new Error(MESSAGES.timeout)
    // 不记录/返回底层网络异常：请求 URL 携带 device token 与 PKCE verifier。
    throw new Error(MESSAGES.network)
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    if (signal.aborted) throw new Error(MESSAGES.cancelled)
    throw new Error(MESSAGES.network)
  }
  if (!text.trim()) throw new Error(MESSAGES.emptyResponse)
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    throw new Error(MESSAGES.invalidResponse)
  }
}

/** 进行中的登录流程的取消控制器（同一时刻只允许一个登录流程）。 */
let activeLoginAbort: AbortController | undefined

/**
 * 发起一次千问账号 device-code 登录。
 *
 * 成功返回额度查询凭据；用户取消、超时或上游拒绝时抛出固定脱敏文案的错误。
 * 登录期间自动用系统浏览器打开经域名校验的授权页。
 */
export async function loginQianwenOAuth(
  options: QianwenLoginOptions = {},
  dependencies: QianwenOAuthDependencies = {},
): Promise<QianwenPlanQuotaCredentials> {
  const createTransport = dependencies.createTransport ?? createManagedProxyFetch
  const sleep = dependencies.sleep ?? defaultSleep
  const openExternal = dependencies.openExternal
    ?? (async (url: string) => { await shell.openExternal(url) })
  const now = dependencies.now ?? Date.now

  activeLoginAbort?.abort()
  const abort = new AbortController()
  activeLoginAbort = abort

  let transport: ManagedProxyFetch | undefined
  try {
    const clientId = readOrCreateQianwenClientId()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    // 每次登录只解析一次代理；managed transport 必须在 finally 关闭。
    const proxyUrl = await getEffectiveProxyUrl()
    if (abort.signal.aborted) throw new Error(MESSAGES.cancelled)
    transport = createTransport(proxyUrl)

    const deviceResponse = await requestJson(
      transport,
      `${QIANWEN_DEVICE_CODE_URL}?client_id=${encodeURIComponent(clientId)}`
        + `&code_challenge=${challenge}&code_challenge_method=S256`,
      abort.signal,
    )
    if (deviceResponse.status >= 500) throw new Error(MESSAGES.failed)
    const device = parseDeviceCode(deviceResponse.body)
    if (!device) throw new Error(MESSAGES.invalidDeviceCode)
    if (!isQianwenVerificationUri(device.verificationUri)) {
      throw new Error(MESSAGES.untrustedVerificationUri)
    }

    // 先推 renderer，再打开浏览器：即使系统浏览器失败，UI 也有可复制的链接。
    options.onDeviceCode?.({ verificationUri: device.verificationUri })
    console.log('[千问登录] 请在浏览器中打开授权页面完成登录')
    try {
      await openExternal(device.verificationUri)
    } catch {
      console.warn('[千问登录] 打开授权页面失败，请手动复制授权链接')
    }

    const deadline = now() + device.expiresInSeconds * 1000
    let intervalMs = device.intervalSeconds * 1000

    for (;;) {
      if (abort.signal.aborted) throw new Error(MESSAGES.cancelled)
      if (now() >= deadline) throw new Error(MESSAGES.deadline)
      await sleep(intervalMs, abort.signal)
      if (abort.signal.aborted) throw new Error(MESSAGES.cancelled)
      if (now() >= deadline) throw new Error(MESSAGES.deadline)

      const tokenResponse = await requestJson(
        transport,
        `${QIANWEN_DEVICE_TOKEN_URL}?client_id=${encodeURIComponent(clientId)}`
          + `&token=${encodeURIComponent(device.token)}&code_verifier=${encodeURIComponent(verifier)}`,
        abort.signal,
      )
      const outcome = classifyTokenResponse(tokenResponse.body)
      if (outcome === 'success') {
        const credentials = parseTokenCredentials(tokenResponse.body, now())
        if (!credentials) {
          const hasAccess = firstString(indexJson(tokenResponse.body), ['accesstoken']) !== undefined
          throw new Error(hasAccess ? MESSAGES.missingExpiry : MESSAGES.missingCredentials)
        }
        return credentials
      }
      if (outcome === 'pending') continue
      if (outcome === 'slow_down') {
        intervalMs += SLOW_DOWN_INCREMENT_MS
        continue
      }
      if (outcome === 'denied') throw new Error(MESSAGES.denied)
      if (outcome === 'expired') throw new Error(MESSAGES.expired)
      if (tokenResponse.status === 429) {
        // 限流仍属于「稍后再试」，与 RFC 8628 的 slow_down 同义。
        intervalMs += SLOW_DOWN_INCREMENT_MS
        continue
      }
      throw new Error(MESSAGES.failed)
    }
  } catch (error) {
    // 服务边界统一脱敏：未知异常不得携带本地路径/代理信息跨进程。
    throw new Error(sanitizeQianwenLoginError(error))
  } finally {
    try { await transport?.close() } catch { /* 关闭失败不能覆盖登录结果，也不记录代理信息。 */ }
    if (activeLoginAbort === abort) activeLoginAbort = undefined
  }
}

/** 取消进行中的千问登录；没有进行中的登录时是无操作。 */
export function cancelQianwenOAuthLogin(): void {
  activeLoginAbort?.abort()
  activeLoginAbort = undefined
}
