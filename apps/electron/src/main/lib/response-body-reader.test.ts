import { describe, expect, test } from 'bun:test'
import { decodeResponseBody, extractCharset, readBoundedBody } from './response-body-reader'

/** 构造可控的分块响应流，并记录是否被 reader.cancel()。 */
function createStream(chunkSize: number, chunkCount: number): {
  stream: ReadableStream<Uint8Array>
  isCanceled: () => boolean
  chunksSent: () => number
} {
  let sent = 0
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61))
    },
    cancel() {
      canceled = true
    },
  })
  return { stream, isCanceled: () => canceled, chunksSent: () => sent }
}

describe('有界响应读取', () => {
  test('Given 2.5MiB 响应流 When 上限 2MiB Then 保留字节不超限且取消剩余流', async () => {
    const maxBytes = 2 * 1024 * 1024
    const { stream, isCanceled } = createStream(64 * 1024, 40)
    const response = new Response(stream, { headers: { 'content-type': 'text/html' } })

    const result = await readBoundedBody(response, maxBytes)

    expect(result.bytes.byteLength).toBe(maxBytes)
    expect(result.truncatedBySize).toBe(true)
    expect(result.canceled).toBe(true)
    expect(isCanceled()).toBe(true)
    // 拉取量最多多出最后一个分块，不会把 2.5MiB 全部读完。
    expect(result.bytesRead).toBeLessThanOrEqual(maxBytes + 64 * 1024)
  })

  test('Given 小于上限的响应流 When 读取 Then 完整返回且不取消', async () => {
    const { stream, isCanceled } = createStream(128, 3)
    const response = new Response(stream, { headers: { 'content-type': 'text/html' } })

    const result = await readBoundedBody(response, 1024)

    expect(result.bytes.byteLength).toBe(384)
    expect(result.truncatedBySize).toBe(false)
    expect(result.canceled).toBe(false)
    expect(isCanceled()).toBe(false)
  })
})

describe('charset 解析与解码', () => {
  test('Given 带引号的 charset When 解析 Then 取出编码名', () => {
    expect(extractCharset('text/html; charset="gbk"')).toBe('gbk')
    expect(extractCharset("text/html; charset='gbk'")).toBe('gbk')
    expect(extractCharset('text/html; charset=utf-8')).toBe('utf-8')
    expect(extractCharset('text/html')).toBeNull()
  })

  test('Given GBK 字节与带引号 charset When 解码 Then 得到中文', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeResponseBody(bytes, 'text/plain; charset="gbk"')).toBe('中文')
  })

  test('Given 未知 charset When 解码 Then 回退 UTF-8 不抛错', () => {
    const bytes = new TextEncoder().encode('兜底')
    expect(decodeResponseBody(bytes, 'text/plain; charset="not-a-real-charset"')).toBe('兜底')
  })
})
