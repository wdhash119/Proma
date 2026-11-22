/**
 * Cua Driver CDN 清单解析与检查调度。
 *
 * Computer Use 的驱动由 CDN 分发，清单是唯一的可信来源。本模块只做两件事：
 *
 * 1. 严格校验清单结构（字段白名单、SemVer、资产名称、摘要与体积上限）；
 * 2. 维护「下一次检查时间」，按天节流并加入随机抖动，避免所有客户端同时打 CDN。
 *
 * 这里不下载任何资产，也不决定是否安装；安装流程由后续阶段单独实现。
 */

import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeTextFileAtomic } from './safe-file'

/** CDN 根地址；清单固定位于 `${CDN}/latest.yml`。 */
const CDN = 'https://cdn.proma.cool/cua-driver'

/** 一天毫秒数，用于检查节流与抖动范围。 */
export const DAY = 24 * 60 * 60 * 1000

/** 清单体积上限，防止异常响应撑爆内存。 */
const MAX_MANIFEST_BYTES = 64 * 1024

/** 单个资产体积上限（1GB），超出即视为清单异常。 */
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024

/** 清单必须完整覆盖的六个平台标签。 */
export const LABELS = [
  'darwin-arm64',
  'darwin-x86_64',
  'windows-arm64',
  'windows-x86_64',
  'linux-arm64',
  'linux-x86_64',
] as const

/** 平台标签字面量类型。 */
type CuaAssetLabel = (typeof LABELS)[number]

/** 清单中的单个资产条目。 */
interface CuaCdnAsset {
  label: CuaAssetLabel
  name: string
  /** 小写十六进制 SHA-256。 */
  sha256: string
  sizeBytes: number
}

/** 校验通过的 CDN 清单。 */
export interface CuaCdnManifest {
  schemaVersion: 1
  /** 纯 SemVer 版本号，与本地 `cua-driver --version` 的输出格式无关。 */
  version: string
  assets: CuaCdnAsset[]
}

/** 清单请求器；默认使用全局 fetch，测试可注入内存实现。 */
export type CuaCdnFetcher = (
  url: string,
  init: { redirect: 'error'; credentials: 'omit'; signal: AbortSignal },
) => Promise<Response>

/** 清单版本号格式：不带前导零的三段数字。 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** 版本号长度上限，避免异常长字符串进入日志与 UI。 */
const VERSION_MAX_LENGTH = 60
/** 摘要格式：64 位小写十六进制。 */
const SHA256_PATTERN = /^[a-f0-9]{64}$/
/** 请求超时时间。 */
const MANIFEST_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 键集合必须与给定白名单完全一致（多键与缺键都拒绝）。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isKnownLabel(value: string): value is CuaAssetLabel {
  return LABELS.some((label) => label === value)
}

/** 资产扩展名：Windows 走 zip，其余平台走 tar.gz。 */
function assetExtension(label: CuaAssetLabel): 'zip' | 'tar.gz' {
  return label.startsWith('windows-') ? 'zip' : 'tar.gz'
}

/**
 * 严格解析 CDN 清单。
 *
 * 任何不符合约定的结构都直接抛错，不做字段兼容或默认值填充：
 * 清单被篡改、截断或被第三方改写时，宁可检查失败也不能据此下载资产。
 */
export function parseCuaCdnManifest(value: unknown): CuaCdnManifest {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'version', 'assets'])
    || value.schemaVersion !== 1
    || typeof value.version !== 'string'
    || value.version.length > VERSION_MAX_LENGTH
    || !VERSION_PATTERN.test(value.version)
    || !Array.isArray(value.assets)
    || value.assets.length !== LABELS.length
  ) {
    throw new Error('Cua CDN 清单格式无效')
  }

  const version = value.version
  const seen = new Set<string>()
  const assets = value.assets.map((asset: unknown): CuaCdnAsset => {
    if (
      !isRecord(asset)
      || !hasExactKeys(asset, ['label', 'name', 'sha256', 'sizeBytes'])
      || typeof asset.label !== 'string'
      || !isKnownLabel(asset.label)
      || seen.has(asset.label)
      || typeof asset.sha256 !== 'string'
      || !SHA256_PATTERN.test(asset.sha256)
      || typeof asset.sizeBytes !== 'number'
      || !Number.isSafeInteger(asset.sizeBytes)
      || asset.sizeBytes <= 0
      || asset.sizeBytes > MAX_ASSET_BYTES
    ) {
      throw new Error('Cua CDN 资产格式无效')
    }

    const label = asset.label
    const expectedName = `cua-driver-rs-${version}-${label}.${assetExtension(label)}`
    if (asset.name !== expectedName) throw new Error('Cua CDN 资产名称无效')

    seen.add(label)
    return { label, name: asset.name, sha256: asset.sha256, sizeBytes: asset.sizeBytes }
  })

  return { schemaVersion: 1, version, assets }
}

/**
 * 把 Node 平台/架构映射为清单标签。
 *
 * 不在清单内的组合（例如 win32 的 ia32、any 架构）返回 undefined，
 * 由调用方按「无法判断」处理，而不是猜测一个可能不存在的资产。
 */
export function cuaAssetLabel(platform: NodeJS.Platform, arch: string): CuaAssetLabel | undefined {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' || platform === 'linux' ? platform : undefined
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : undefined
  if (!os || !cpu) return undefined
  const label = `${os}-${cpu}`
  return isKnownLabel(label) ? label : undefined
}

/** 发起请求并做基础防护：禁止重定向、禁止携带凭据、超时即失败。 */
async function requestManifest(fetcher: CuaCdnFetcher, url: string): Promise<Response> {
  const response = await fetcher(url, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  })
  if (!response.ok || response.redirected || response.url !== url) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Cua CDN 请求失败: HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('Cua CDN 响应为空')
  return response
}

/**
 * 拉取并解析清单。
 *
 * 用流式读取累计字节数，超过上限立即中断，避免异常响应占用内存。
 */
export async function fetchCuaCdnManifest(fetcher: CuaCdnFetcher): Promise<CuaCdnManifest> {
  const url = `${CDN}/latest.yml`
  const response = await requestManifest(fetcher, url)
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_MANIFEST_BYTES) throw new Error('Cua CDN 清单过大')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Cua CDN 清单格式无效')
  }
  return parseCuaCdnManifest(parsed)
}

/** 调度状态的读写注入点；默认走真实文件系统，测试可用内存实现。 */
export interface CuaCdnCheckStateIo {
  /** 读取状态文本；文件不存在或不可读时返回 undefined。 */
  readText: (filePath: string) => string | undefined
  /** 原子写入状态文本，必要时创建父目录。 */
  writeText: (filePath: string, content: string) => void
}

const defaultStateIo: CuaCdnCheckStateIo = {
  readText: (filePath) => {
    try {
      return readFileSync(filePath, 'utf8')
    } catch {
      return undefined
    }
  },
  writeText: (filePath, content) => {
    mkdirSync(dirname(filePath), { recursive: true })
    writeTextFileAtomic(filePath, content)
  },
}

/** 首次检查的最小延迟：启动后 1 分钟再请求，避免拖慢冷启动。 */
const FIRST_CHECK_MIN_DELAY_MS = 60_000
/** 允许的调度时间最多超前两天，超出视为状态被改写。 */
const SCHEDULE_TOLERANCE_MS = 2 * DAY

/**
 * 检查调度：把「下一次检查时间」持久化到配置目录。
 *
 * 首次安装或状态损坏时，下一次检查落在「1 分钟后 + 一天内的随机抖动」，
 * 让不同客户端的请求自然错开。检查到期后无论成功失败都顺延一天。
 */
export class CuaCdnCheckSchedule {
  private readonly statePath: string
  private readonly now: () => number
  private readonly jitter: () => number
  private readonly io: CuaCdnCheckStateIo
  private next: number

  constructor(
    statePath: string,
    now: () => number = Date.now,
    jitter: () => number = () => randomInt(0, DAY),
    io: CuaCdnCheckStateIo = defaultStateIo,
  ) {
    this.statePath = statePath
    this.now = now
    this.jitter = jitter
    this.io = io

    const time = now()
    const saved = this.readState()
    this.next =
      saved && saved.nextCheckAt <= time + SCHEDULE_TOLERANCE_MS
        ? saved.nextCheckAt
        : time + FIRST_CHECK_MIN_DELAY_MS + this.randomOffset()
    this.persist()
  }

  /** 读取已持久化的调度时间；结构不符（含改写、截断）一律当作没有记录。 */
  private readState(): { nextCheckAt: number } | undefined {
    const text = this.io.readText(this.statePath)
    if (text === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || parsed.schemaVersion !== 1) return undefined
      const nextCheckAt = parsed.nextCheckAt
      if (typeof nextCheckAt !== 'number' || !Number.isSafeInteger(nextCheckAt) || nextCheckAt <= 0) return undefined
      return { nextCheckAt }
    } catch {
      return undefined
    }
  }

  /** 抖动必须是非负整数且小于一天，否则说明注入逻辑有误。 */
  private randomOffset(): number {
    const value = this.jitter()
    if (!Number.isInteger(value) || value < 0 || value >= DAY) throw new Error('Cua 检查随机偏移无效')
    return value
  }

  private persist(): void {
    this.io.writeText(this.statePath, JSON.stringify({ schemaVersion: 1, nextCheckAt: this.next }))
  }

  /** 下一次允许检查的时间戳（毫秒）。 */
  get nextCheckAt(): number {
    return this.next
  }

  /**
   * 请求前占用一次调度。
   *
   * 未到期返回 false；到期则先把下一次时间推进一天并落盘，
   * 落盘失败时回退内存值并抛出，避免进程内状态与磁盘不一致。
   * 占用成功不代表检查一定成功，失败按日重试即可。
   */
  claimIfDue(): boolean {
    const time = this.now()
    if (time < this.next) return false
    const previous = this.next
    this.next = time + DAY
    try {
      this.persist()
    } catch (error) {
      this.next = previous
      throw error
    }
    return true
  }
}
