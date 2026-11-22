/**
 * Live Compact 上游客户端：查询 GitHub 默认分支 HEAD，并按 commit sha 下载 tarball。
 *
 * 上游 `carrotciallo/pi-live-compact` **没有 releases、没有 tags**（父会话已核实），
 * 因此唯一可钉的同步源是「默认分支 HEAD 的 commit sha」：先查 sha，再把 sha 钉进
 * codeload 地址下载。用分支名下载会引入「查到的 sha 与下载到的内容不一致」的窗口。
 *
 * 纪律对齐 `computer-use-cdn-update.ts`：
 * - 严格校验（sha 必须是 40 位小写十六进制，日期必须是合法 ISO 8601）；
 * - 禁止重定向、禁止携带凭据、超时即失败；
 * - 流式读取并累计字节数，超上限立即中断（清单 256KB、tarball 5MB）。
 *
 * 本文件不落盘（下载除外）、不校验业务语义：版本合法性、导出形状与测试闸在
 * `live-compact-sync.ts`。
 */

import { open, rm } from 'node:fs/promises'

/** 上游仓库（owner/name）。 */
export const UPSTREAM_REPO = 'carrotciallo/pi-live-compact'

const UPSTREAM_API_BASE = 'https://api.github.com'
const UPSTREAM_CODELOAD_BASE = 'https://codeload.github.com'

/** HEAD 响应体积上限：GitHub commit 对象约 5KB，256KB 已足够宽松。 */
export const MAX_HEAD_RESPONSE_BYTES = 256 * 1024

/** tarball 体积上限：上游包（含四件算法与 94 例测试源码）实际约 120KB。 */
export const MAX_TARBALL_BYTES = 5 * 1024 * 1024

/** HEAD 查询超时。 */
const HEAD_TIMEOUT_MS = 30_000

/** tarball 下载超时（整条流的截止时间）。 */
const TARBALL_TIMEOUT_MS = 120_000

/** commit sha：40 位小写十六进制，大小写或长度不符一律拒绝。 */
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/

/** 日期必须是带时区的 ISO 8601（GitHub 实际输出 `2026-11-16T12:34:56Z`）。 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

/** GitHub API 要求显式 User-Agent，缺失会被 403 拦掉。 */
const USER_AGENT = 'Proma-LiveCompactSync/1.0 (+https://proma.cool)'

/** 已校验的上游 HEAD。 */
export interface LiveCompactUpstreamHead {
  /** 40 位小写十六进制 commit sha。 */
  sha: string
  /** commit.author.date 归一化后的 ISO 8601 字符串。 */
  date: string
}

/** 请求参数类型：只允许最保守的一组选项（禁重定向、禁凭据、带超时信号）。 */
export type LiveCompactFetchInit = {
  headers: Record<string, string>
  redirect: 'error'
  credentials: 'omit'
  signal: AbortSignal
}

/** 可注入的 fetch，测试用内存实现，生产走全局 fetch。 */
export type LiveCompactFetcher = (url: string, init: LiveCompactFetchInit) => Promise<Response>

/** 默认 fetcher：直接使用全局 fetch（与 Cua CDN 检查保持同一策略，不走代理配置）。 */
export const defaultLiveCompactFetcher: LiveCompactFetcher = async (url, init) => await fetch(url, init)

/** 下载结果：实际落盘字节数。 */
export interface LiveCompactDownloadResult {
  bytes: number
  path: string
}

/** 下载依赖注入面（测试可替换 fetch 与目标路径）。 */
export interface LiveCompactDownloadDeps {
  fetcher?: LiveCompactFetcher
  maxBytes?: number
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** sha 判定：只接受 40 位小写十六进制。 */
export function isValidCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA_PATTERN.test(value)
}

/**
 * 日期判定与归一化：格式合法且能被 Date 解析，否则返回 undefined。
 *
 * 归一化到 `toISOString()` 有两个目的：设置页展示格式统一；把带偏移的时间折算成 UTC，
 * 避免同一时刻出现两种字面量。
 */
export function normalizeCommitDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString()
}

/**
 * 严格解析 GitHub `GET /commits/HEAD` 响应。
 *
 * 只读两个字段（sha、commit.author.date），但要求对象层级存在；任何异常一律抛错，
 * 不做兼容与默认值填充——同步源被篡改时宁可检查失败也不能据此下载。
 */
export function parseUpstreamHeadPayload(value: unknown): LiveCompactUpstreamHead {
  if (!isRecord(value)) throw new Error('GitHub HEAD 响应格式无效：不是对象')
  const sha = value.sha
  if (!isValidCommitSha(sha)) throw new Error('GitHub HEAD 响应格式无效：sha 不是 40 位小写十六进制')
  const commit = value.commit
  if (!isRecord(commit)) throw new Error('GitHub HEAD 响应格式无效：缺少 commit')
  const author = commit.author
  if (!isRecord(author)) throw new Error('GitHub HEAD 响应格式无效：缺少 commit.author')
  const date = normalizeCommitDate(author.date)
  if (!date) throw new Error('GitHub HEAD 响应格式无效：commit.author.date 不是合法 ISO 时间')
  return { sha, date }
}

/** HEAD 查询地址。 */
export function upstreamHeadUrl(): string {
  return `${UPSTREAM_API_BASE}/repos/${UPSTREAM_REPO}/commits/HEAD`
}

/**
 * 按 commit sha 生成 tarball 地址。
 *
 * 必须钉 sha：分支名会在查询与下载之间移动，钉 sha 才能保证「过闸的内容」就是
 * 「装上机的内容」。
 */
export function tarballUrl(sha: string): string {
  if (!isValidCommitSha(sha)) throw new Error('tarball 地址需要 40 位小写十六进制 commit sha')
  return `${UPSTREAM_CODELOAD_BASE}/${UPSTREAM_REPO}/tar.gz/${sha}`
}

/** 发起请求并做基础防护：禁重定向、禁凭据、超时即失败。 */
async function request(
  fetcher: LiveCompactFetcher,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok || response.status !== 200 || response.redirected || response.url !== url) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`上游请求失败: HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('上游响应为空')
  return response
}

/**
 * 查询默认分支 HEAD。
 *
 * 用流式读取累计字节数并在超限时中断，避免异常响应把内存撑爆；正文最后整体 JSON 解析。
 */
export async function fetchUpstreamHead(
  fetcher: LiveCompactFetcher = defaultLiveCompactFetcher,
  maxBytes: number = MAX_HEAD_RESPONSE_BYTES,
): Promise<LiveCompactUpstreamHead> {
  const url = upstreamHeadUrl()
  const response = await request(
    fetcher,
    url,
    {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
    HEAD_TIMEOUT_MS,
  )

  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) throw new Error('GitHub HEAD 响应过大')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('GitHub HEAD 响应格式无效：不是 JSON')
  }
  return parseUpstreamHeadPayload(parsed)
}

/**
 * 下载 tarball 并流式落盘。
 *
 * 两种失败必须区分：
 * - 非 200 / 被重定向 / 空响应 → 请求阶段失败；
 * - 累计字节超过上限 → 立刻取消响应流、删除半成品文件并抛错。
 * 任何失败都不会留下不完整的 tar 文件，避免后续解包读到半截内容。
 */
export async function downloadUpstreamTarball(
  sha: string,
  destinationPath: string,
  deps: LiveCompactDownloadDeps = {},
): Promise<LiveCompactDownloadResult> {
  const fetcher = deps.fetcher ?? defaultLiveCompactFetcher
  const maxBytes = deps.maxBytes ?? MAX_TARBALL_BYTES
  const url = tarballUrl(sha)

  const response = await request(
    fetcher,
    url,
    { Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
    deps.timeoutMs ?? TARBALL_TIMEOUT_MS,
  )

  const handle = await open(destinationPath, 'w')
  const reader = response.body!.getReader()
  let bytes = 0
  let completed = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new Error(`上游 tarball 超过 ${maxBytes} 字节上限`)
      await handle.write(next.value)
    }
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle.close().catch(() => undefined)
    if (!completed) await rm(destinationPath, { force: true }).catch(() => undefined)
  }

  return { bytes, path: destinationPath }
}
