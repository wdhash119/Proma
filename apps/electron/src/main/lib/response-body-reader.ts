/**
 * Web 响应正文的有界读取与解码（WebFetch / WebSearch 共用）。
 *
 * 关键点：
 * - 通过 `response.body.getReader()` 边读边累计，超过 `maxBytes` 立即切尾并
 *   调用 `reader.cancel()`，避免先把整页读进内存再截断；
 * - 保留字节数始终不超过上限；从底层流拉取的字节数最多多出最后一个分块；
 * - charset 解析兼容 `charset="gbk"` / `charset='gbk'` 这类带引号写法。
 */

export interface BoundedBodyResult {
  /** 保留下来的正文字节，最多 `maxBytes`。 */
  bytes: Uint8Array
  /** 是否因超过上限而截断。 */
  truncatedBySize: boolean
  /** 从响应流实际拉取的原始字节数；可能比上限多最后一个分块。 */
  bytesRead: number
  /** 是否因超限主动取消了底层 reader。 */
  canceled: boolean
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** 读取响应正文，最多保留 `maxBytes`；超限时取消剩余流。 */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBodyResult> {
  const body = response.body
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    const bytes = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer
    return {
      bytes,
      truncatedBySize: buffer.byteLength > maxBytes,
      bytesRead: buffer.byteLength,
      canceled: false,
    }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let bytesRead = 0
  let truncatedBySize = false
  let canceled = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytesRead += value.byteLength
      const remaining = maxBytes - retained
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        retained += Math.max(0, remaining)
        truncatedBySize = true
        await reader.cancel().catch(() => undefined)
        canceled = true
        break
      }
      chunks.push(value)
      retained += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  return { bytes: concatChunks(chunks), truncatedBySize, bytesRead, canceled }
}

/** 解析 content-type 中的 charset，兼容单双引号。 */
export function extractCharset(contentType: string | null): string | null {
  return /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? null
}

/** 按响应 charset 解码正文；未知编码回退 UTF-8。 */
export function decodeResponseBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = extractCharset(contentType)
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}
