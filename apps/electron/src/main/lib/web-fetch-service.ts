/**
 * WebFetch：抓取单个网页并转成 Markdown 正文。
 *
 * 完全本地实现，不经过任何 Proma 服务，也不引入额外依赖：
 * - 只接受 http/https 且不带账号密码的 URL；
 * - 跟随有限次重定向，整体有超时与体积上限；
 * - HTML 走 htmlToMarkdown，纯文本与 Markdown 原样返回；
 * - 其它类型（二进制、PDF 等）返回可读错误，交给浏览器或本地工具处理。
 */

import { extractHtmlTitle, htmlToMarkdown } from './html-to-markdown'

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_BYTES = 3 * 1024 * 1024
const MAX_CONTENT_CHARS = 120_000
const MAX_REDIRECTS = 5
const USER_AGENT = 'Proma/1.0 (+https://proma.cool) WebFetch'

export interface WebFetchResult {
  ok: true
  url: string
  title: string
  content: string
  truncated?: boolean
  status: number
}

export interface WebFetchFailure {
  ok: false
  url: string
  status?: number
  error: string
}

export type WebFetchOutcome = WebFetchResult | WebFetchFailure

export interface WebFetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxChars?: number
}

/** 校验并归一化 URL；只允许无凭据的 http(s)。 */
export function normalizeFetchUrl(input: string): URL | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return url
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml')
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType.includes('application/json')
    || contentType.includes('application/xml') || contentType.includes('text/markdown')
}

/** 单次抓取与转换；失败统一转成可读错误而不是抛异常。 */
export async function fetchPageAsMarkdown(input: string, options: WebFetchOptions = {}): Promise<WebFetchOutcome> {
  const url = normalizeFetchUrl(input)
  if (!url) {
    return { ok: false, url: input, error: '请提供不带账号密码的 http(s) 链接。' }
  }

  if (options.signal?.aborted) {
    return { ok: false, url: url.toString(), error: '抓取已取消。' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let current = url
    let response: Response | undefined

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) break
        const next = normalizeFetchUrl(new URL(location, current).toString())
        if (!next) {
          return { ok: false, url: current.toString(), status: response.status, error: '重定向指向了不支持的地址。' }
        }
        current = next
        continue
      }
      break
    }

    if (!response) {
      return { ok: false, url: url.toString(), error: '抓取失败：没有得到响应。' }
    }
    if (!response.ok) {
      return {
        ok: false,
        url: current.toString(),
        status: response.status,
        error: `页面返回 HTTP ${response.status}。${response.status === 404 ? '链接可能已失效。' : '请检查链接或改用浏览器打开。'}`,
      }
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!isHtmlContentType(contentType) && !isTextContentType(contentType)) {
      return {
        ok: false,
        url: current.toString(),
        status: response.status,
        error: `该链接是 ${contentType || '未知类型'} 内容，不是可读文本；请用浏览器或下载后本地处理。`,
      }
    }

    const buffer = await readBounded(response)
    if (buffer.truncatedBySize) {
      // 体积超限时仍然解析已读到的部分，并在正文末尾标注。
    }
    const raw = buffer.text
    const maxChars = options.maxChars ?? MAX_CONTENT_CHARS
    const isHtml = isHtmlContentType(contentType)
    const title = isHtml ? extractHtmlTitle(raw) : null
    const content = isHtml
      ? htmlToMarkdown(raw, { maxChars })
      : raw.length > maxChars
        ? `${raw.slice(0, maxChars)}\n\n…（内容过长，已截断）`
        : raw

    if (!content.trim()) {
      return {
        ok: false,
        url: current.toString(),
        status: response.status,
        error: '页面返回了空内容或无法提取正文，请改用浏览器打开。',
      }
    }

    return {
      ok: true,
      url: current.toString(),
      title: title ?? current.toString(),
      content,
      ...(buffer.truncatedBySize || content.length >= maxChars ? { truncated: true } : {}),
      status: response.status,
    }
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      return { ok: false, url: url.toString(), error: '抓取超时，请稍后重试或改用浏览器打开。' }
    }
    if (options.signal?.aborted) {
      return { ok: false, url: url.toString(), error: '抓取已取消。' }
    }
    return {
      ok: false,
      url: url.toString(),
      error: `抓取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** 边读边累计，超过上限就停止，避免大文件把内存吃满。 */
async function readBounded(response: Response): Promise<{ text: string; truncatedBySize: boolean }> {
  const body = response.body
  if (!body) return { text: await response.text(), truncatedBySize: false }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncatedBySize = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BYTES) {
      const remaining = MAX_BYTES - (total - value.byteLength)
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      truncatedBySize = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
  try {
    return { text: new TextDecoder(charset ?? 'utf-8').decode(merged), truncatedBySize }
  } catch {
    return { text: new TextDecoder('utf-8').decode(merged), truncatedBySize }
  }
}

/** 把结果压成给模型看的文本；成功时是正文 Markdown。 */
export function formatWebFetchOutcome(outcome: WebFetchOutcome): string {
  if (!outcome.ok) return outcome.error
  const header = `# ${outcome.title}\n\n来源：${outcome.url}\n\n`
  return `${header}${outcome.content}`
}
