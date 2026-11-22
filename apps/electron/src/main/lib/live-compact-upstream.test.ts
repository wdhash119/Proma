import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadUpstreamTarball,
  fetchUpstreamHead,
  isValidCommitSha,
  MAX_HEAD_RESPONSE_BYTES,
  normalizeCommitDate,
  parseUpstreamHeadPayload,
  tarballUrl,
  upstreamHeadUrl,
  UPSTREAM_REPO,
  type LiveCompactFetcher,
} from './live-compact-upstream'

const VALID_SHA = '6da2d086f111171446e0eda610527732b1800f4a'
const HEAD_URL = `https://api.github.com/repos/${UPSTREAM_REPO}/commits/HEAD`

const temporaryRoots: string[] = []

function createTemporaryDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-live-compact-upstream-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 构造带正确 url 的 Response（原生 Response 的 url 恒为空串，这里显式覆写）。 */
function responseWithUrl(body: BodyInit | null, url: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

/** 拼装一次性 fetch 替身，返回固定响应并记录调用。 */
function fetcherReturning(response: Response, calls: string[] = []): LiveCompactFetcher {
  return async (url) => {
    calls.push(url)
    return response
  }
}

/** GitHub HEAD 响应的最小同构样本。 */
function headPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: VALID_SHA,
    commit: {
      author: { name: 'carrotciallo', date: '2026-11-16T12:34:56Z' },
      message: 'release 0.12.0',
    },
    ...overrides,
  }
}

describe('Live Compact 上游：commit sha 校验', () => {
  test('Given 40 位小写十六进制 When 校验 Then 通过', () => {
    expect(isValidCommitSha(VALID_SHA)).toBe(true)
  })

  test('Given 长度不足 40 位 When 校验 Then 拒绝', () => {
    expect(isValidCommitSha(VALID_SHA.slice(0, 39))).toBe(false)
  })

  test('Given 长度超过 40 位 When 校验 Then 拒绝', () => {
    expect(isValidCommitSha(`${VALID_SHA}0`)).toBe(false)
  })

  test('Given 含大写字母 When 校验 Then 拒绝', () => {
    expect(isValidCommitSha(VALID_SHA.toUpperCase())).toBe(false)
  })

  test('Given 含非十六进制字符 When 校验 Then 拒绝', () => {
    expect(isValidCommitSha('z'.repeat(40))).toBe(false)
    expect(isValidCommitSha(`${'a'.repeat(39)}-`)).toBe(false)
  })

  test('Given 非字符串 When 校验 Then 拒绝', () => {
    expect(isValidCommitSha(undefined)).toBe(false)
    expect(isValidCommitSha(123)).toBe(false)
    expect(isValidCommitSha({ sha: VALID_SHA })).toBe(false)
  })
})

describe('Live Compact 上游：commit 日期校验', () => {
  test('Given 标准 Z 结尾时间 When 校验 Then 归一为毫秒精度 UTC', () => {
    expect(normalizeCommitDate('2026-11-16T12:34:56Z')).toBe('2026-11-16T12:34:56.000Z')
  })

  test('Given 带毫秒 When 校验 Then 保留毫秒', () => {
    expect(normalizeCommitDate('2026-11-16T12:34:56.789Z')).toBe('2026-11-16T12:34:56.789Z')
  })

  test('Given 带时区偏移 When 校验 Then 折算成 UTC', () => {
    expect(normalizeCommitDate('2026-11-16T20:34:56+08:00')).toBe('2026-11-16T12:34:56.000Z')
  })

  test('Given 缺少时区 When 校验 Then 拒绝', () => {
    expect(normalizeCommitDate('2026-11-16T12:34:56')).toBeUndefined()
  })

  test('Given 日期字面量越界 When 校验 Then 拒绝', () => {
    expect(normalizeCommitDate('2026-13-45T99:99:99Z')).toBeUndefined()
  })

  test('Given 非字符串 When 校验 Then 拒绝', () => {
    expect(normalizeCommitDate(1_763_300_000_000)).toBeUndefined()
    expect(normalizeCommitDate(null)).toBeUndefined()
  })
})

describe('Live Compact 上游：HEAD 响应解析', () => {
  test('Given 完整响应 When 解析 Then 取出 sha 与归一日期', () => {
    expect(parseUpstreamHeadPayload(headPayload())).toEqual({
      sha: VALID_SHA,
      date: '2026-11-16T12:34:56.000Z',
    })
  })

  test('Given 顶层不是对象 When 解析 Then 拒绝', () => {
    expect(() => parseUpstreamHeadPayload([])).toThrow('不是对象')
    expect(() => parseUpstreamHeadPayload('sha')).toThrow('不是对象')
  })

  test('Given sha 非法 When 解析 Then 拒绝', () => {
    expect(() => parseUpstreamHeadPayload(headPayload({ sha: 'abc' }))).toThrow('sha 不是 40 位小写十六进制')
  })

  test('Given 缺少 commit When 解析 Then 拒绝', () => {
    const payload = headPayload()
    delete payload.commit
    expect(() => parseUpstreamHeadPayload(payload)).toThrow('缺少 commit')
  })

  test('Given 缺少 commit.author When 解析 Then 拒绝', () => {
    expect(() => parseUpstreamHeadPayload({ sha: VALID_SHA, commit: {} })).toThrow('缺少 commit.author')
  })

  test('Given 日期非法 When 解析 Then 拒绝', () => {
    expect(() =>
      parseUpstreamHeadPayload(headPayload({ commit: { author: { date: '2026-11-16' } } })),
    ).toThrow('不是合法 ISO 时间')
  })
})

describe('Live Compact 上游：tarball 地址', () => {
  test('Given 合法 sha When 生成地址 Then 钉住 sha 且走 codeload', () => {
    expect(tarballUrl(VALID_SHA)).toBe(
      `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${VALID_SHA}`,
    )
  })

  test('Given 非法 sha When 生成地址 Then 抛错（不允许退化成分支名）', () => {
    expect(() => tarballUrl('main')).toThrow('40 位小写十六进制')
    expect(() => tarballUrl(VALID_SHA.toUpperCase())).toThrow('40 位小写十六进制')
  })

  test('Given 无参数 When 查询 HEAD 地址 Then 指向 commits/HEAD', () => {
    expect(upstreamHeadUrl()).toBe(HEAD_URL)
  })
})

describe('Live Compact 上游：HEAD 拉取', () => {
  test('Given 正常响应 When 拉取 Then 返回 sha 与日期', async () => {
    const calls: string[] = []
    const head = await fetchUpstreamHead(
      fetcherReturning(responseWithUrl(JSON.stringify(headPayload()), HEAD_URL), calls),
    )

    expect(calls).toEqual([HEAD_URL])
    expect(head.sha).toBe(VALID_SHA)
    expect(head.date).toBe('2026-11-16T12:34:56.000Z')
  })

  test('Given 请求头 When 拉取 Then 带 GitHub 媒体类型与 User-Agent', async () => {
    let seenHeaders: Record<string, string> = {}
    await fetchUpstreamHead(async (url, init) => {
      expect(url).toBe(HEAD_URL)
      seenHeaders = init.headers
      expect(init.redirect).toBe('error')
      expect(init.credentials).toBe('omit')
      return responseWithUrl(JSON.stringify(headPayload()), HEAD_URL)
    })

    expect(seenHeaders.Accept).toBe('application/vnd.github+json')
    expect(seenHeaders['User-Agent']).toContain('Proma')
  })

  test('Given 非 200 When 拉取 Then 抛请求失败', async () => {
    await expect(
      fetchUpstreamHead(fetcherReturning(responseWithUrl('oops', HEAD_URL, { status: 503 }))),
    ).rejects.toThrow('上游请求失败: HTTP 503')
  })

  test('Given 响应被重定向 When 拉取 Then 抛请求失败', async () => {
    const response = responseWithUrl(JSON.stringify(headPayload()), 'https://mirror.example.com/head')
    await expect(fetchUpstreamHead(fetcherReturning(response))).rejects.toThrow('上游请求失败: HTTP 200')
  })

  test('Given 响应没有正文 When 拉取 Then 抛响应为空', async () => {
    await expect(fetchUpstreamHead(fetcherReturning(responseWithUrl(null, HEAD_URL)))).rejects.toThrow(
      '上游响应为空',
    )
  })

  test('Given 正文超过体积上限 When 拉取 Then 抛响应过大', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(MAX_HEAD_RESPONSE_BYTES) })
    await expect(fetchUpstreamHead(fetcherReturning(responseWithUrl(oversized, HEAD_URL)))).rejects.toThrow(
      'GitHub HEAD 响应过大',
    )
  })

  test('Given 分块响应累计超过上限 When 拉取 Then 抛响应过大', async () => {
    const chunk = 'y'.repeat(64 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index++) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      },
    })
    await expect(
      fetchUpstreamHead(fetcherReturning(responseWithUrl(stream, HEAD_URL)), 128 * 1024),
    ).rejects.toThrow('GitHub HEAD 响应过大')
  })

  test('Given 正文不是 JSON When 拉取 Then 抛格式无效', async () => {
    await expect(fetchUpstreamHead(fetcherReturning(responseWithUrl('not json', HEAD_URL)))).rejects.toThrow(
      '不是 JSON',
    )
  })
})

describe('Live Compact 上游：tarball 下载', () => {
  test('Given 正常响应 When 下载 Then 流式落盘并回报字节数', async () => {
    const root = createTemporaryDir()
    const destination = join(root, 'upstream.tar.gz')
    const payload = new TextEncoder().encode('fake-tarball-bytes')
    const calls: string[] = []

    const result = await downloadUpstreamTarball(VALID_SHA, destination, {
      fetcher: fetcherReturning(responseWithUrl(payload, tarballUrl(VALID_SHA)), calls),
    })

    expect(calls).toEqual([tarballUrl(VALID_SHA)])
    expect(result.bytes).toBe(payload.byteLength)
    expect(statSync(destination).size).toBe(payload.byteLength)
    expect(readFileSync(destination).toString('utf8')).toBe('fake-tarball-bytes')
  })

  test('Given 分块响应 When 下载 Then 内容完整拼接', async () => {
    const root = createTemporaryDir()
    const destination = join(root, 'upstream.tar.gz')
    const chunks = ['第一段', '第二段', '第三段']
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })

    const result = await downloadUpstreamTarball(VALID_SHA, destination, {
      fetcher: fetcherReturning(responseWithUrl(stream, tarballUrl(VALID_SHA))),
    })

    expect(result.bytes).toBeGreaterThan(0)
    expect(readFileSync(destination).toString('utf8')).toBe(chunks.join(''))
  })

  test('Given 超过体积上限 When 下载 Then 抛错且不留半成品文件', async () => {
    const root = createTemporaryDir()
    const destination = join(root, 'upstream.tar.gz')

    await expect(
      downloadUpstreamTarball(VALID_SHA, destination, {
        fetcher: fetcherReturning(
          responseWithUrl(new TextEncoder().encode('x'.repeat(4096)), tarballUrl(VALID_SHA)),
        ),
        maxBytes: 1024,
      }),
    ).rejects.toThrow('超过 1024 字节上限')

    expect(() => statSync(destination)).toThrow()
  })

  test('Given 非 200 When 下载 Then 抛请求失败且不建文件', async () => {
    const root = createTemporaryDir()
    const destination = join(root, 'upstream.tar.gz')

    await expect(
      downloadUpstreamTarball(VALID_SHA, destination, {
        fetcher: fetcherReturning(responseWithUrl('nope', tarballUrl(VALID_SHA), { status: 404 })),
      }),
    ).rejects.toThrow('上游请求失败: HTTP 404')

    expect(() => statSync(destination)).toThrow()
  })

  test('Given 已有同名旧文件但下载失败 When 下载 Then 旧文件被清掉（不留下失效 tar）', async () => {
    const root = createTemporaryDir()
    const destination = join(root, 'upstream.tar.gz')
    writeFileSync(destination, 'stale')

    await expect(
      downloadUpstreamTarball(VALID_SHA, destination, {
        fetcher: fetcherReturning(
          responseWithUrl(new TextEncoder().encode('x'.repeat(4096)), tarballUrl(VALID_SHA)),
        ),
        maxBytes: 1024,
      }),
    ).rejects.toThrow('超过 1024 字节上限')

    expect(() => statSync(destination)).toThrow()
  })
})
