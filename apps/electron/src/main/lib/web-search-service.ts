/**
 * WebSearch：无密钥的公开网页检索。
 *
 * 不使用任何 Proma 服务，也不要求用户配置 API Key：默认走 DuckDuckGo 的
 * HTML 端点（服务端渲染、无 JS 依赖），解析出标题/链接/摘要。
 *
 * 取舍说明：
 * - 结果质量与稳定性不如付费搜索 API，命中差时应改用受管浏览器打开来源页核对；
 * - 端点被限流或结构变化时返回可读错误，而不是静默返回空结果；
 * - 详情要留在来源页上，因此不做二次抓取（那是 WebFetch 的职责）。
 */

import { decodeHtmlEntities } from './html-entities'
import { readBoundedBody } from './response-body-reader'
import { normalizeFetchUrl } from './web-fetch-service'

const SEARCH_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_COUNT = 10
const MAX_COUNT = 50
const USER_AGENT = 'Mozilla/5.0 (compatible; Proma/1.0; +https://proma.cool) WebSearch'

export interface WebSearchItem {
  title: string
  url: string
  snippet?: string
}

export interface WebSearchSuccess {
  ok: true
  query: string
  resultCount: number
  results: WebSearchItem[]
  note?: string
}

export interface WebSearchFailure {
  ok: false
  query: string
  error: string
  hint?: string
}

export type WebSearchOutcome = WebSearchSuccess | WebSearchFailure

export interface WebSearchOptions {
  count?: number
  signal?: AbortSignal
  /** 仅供测试：替换底层抓取实现。 */
  fetcher?: (url: string, signal?: AbortSignal) => Promise<string>
}

function decodeEntities(input: string): string {
  return decodeHtmlEntities(input)
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, '')
}

function cleanText(input: string): string {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim()
}

/**
 * DuckDuckGo 的跳转链接形如 `//duckduckgo.com/l/?uddg=<encoded>&rut=...`，
 * 需要解出真实地址；直链原样返回。
 */
export function resolveDuckDuckGoHref(href: string): string | null {
  const value = decodeEntities(href.trim())
  if (!value) return null
  const absolute = value.startsWith('//') ? `https:${value}` : value
  try {
    const url = new URL(absolute, 'https://duckduckgo.com')
    if (url.pathname === '/l/' || url.pathname === '/l') {
      const target = url.searchParams.get('uddg')
      return target ? normalizeFetchUrl(target)?.toString() ?? null : null
    }
    return normalizeFetchUrl(url.toString())?.toString() ?? null
  } catch {
    return null
  }
}

/** 解析 DuckDuckGo HTML 结果页。结构变化时返回空数组，由调用方转成可读提示。 */
export function parseDuckDuckGoHtml(html: string, count: number): WebSearchItem[] {
  const results: WebSearchItem[] = []
  const seen = new Set<string>()

  const blockPattern = /<div\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  const blocks = html.match(blockPattern) ?? [html]

  for (const block of blocks) {
    const link = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(block)
    if (!link) continue
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(link[1] ?? '')
    const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? ''
    const url = resolveDuckDuckGoHref(href)
    if (!url || seen.has(url)) continue

    const title = cleanText(link[2] ?? '')
    if (!title) continue

    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block)
    const snippet = snippetMatch?.[1] ? cleanText(snippetMatch[1]) : undefined

    seen.add(url)
    results.push({ title, url, ...(snippet ? { snippet } : {}) })
    if (results.length >= count) break
  }

  return results
}

/** 默认抓取实现；导出供测试注入已取消 signal 与大体积流。 */
export async function defaultFetcher(url: string, signal?: AbortSignal): Promise<string> {
  // 调用方传入的 signal 可能已经 aborted，此时 addEventListener 不会再触发，
  // 必须在发起 fetch 前直接早退，避免搜索照常下载。
  if (signal?.aborted) throw new Error('检索已取消')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!response.ok) {
      throw new Error(`搜索服务返回 HTTP ${response.status}`)
    }
    // 边读边停：超过 2 MiB 立即切尾并取消 reader，不再完整缓冲整页。
    const body = await readBoundedBody(response, MAX_RESPONSE_BYTES)
    return new TextDecoder('utf-8').decode(body.bytes)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 执行一次检索；`note` 用于说明「确实没有结果」而不是报错。 */
export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<WebSearchOutcome> {
  const trimmed = query.trim()
  if (!trimmed) return { ok: false, query, error: 'query 不能为空。' }
  if (trimmed.length > 128) return { ok: false, query, error: 'query 最多 128 个字符。' }

  const count = Math.min(Math.max(1, Math.round(options.count ?? DEFAULT_COUNT)), MAX_COUNT)
  const fetcher = options.fetcher ?? defaultFetcher
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`

  try {
    const html = await fetcher(url, options.signal)
    const results = parseDuckDuckGoHtml(html, count)
    if (results.length === 0) {
      return {
        ok: true,
        query: trimmed,
        resultCount: 0,
        results: [],
        note: '没有解析到结果。可以换更宽的查询词、去掉过严的运算符，或改用受管浏览器打开来源页。',
      }
    }
    return { ok: true, query: trimmed, resultCount: results.length, results }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      query: trimmed,
      error: `检索失败：${message}`,
      hint: '公开搜索端点可能被限流或不可达；改用受管浏览器打开搜索引擎或来源页核对。',
    }
  }
}

/** 给模型看的文本形式；成功时是逐条编号的列表。 */
export function formatWebSearchOutcome(outcome: WebSearchOutcome): string {
  if (!outcome.ok) return `${outcome.error}${outcome.hint ? `\n${outcome.hint}` : ''}`
  if (outcome.results.length === 0) return outcome.note ?? '没有结果。'
  const lines = outcome.results.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`, `   ${item.url}`]
    if (item.snippet) parts.push(`   ${item.snippet}`)
    return parts.join('\n')
  })
  return lines.join('\n\n')
}
