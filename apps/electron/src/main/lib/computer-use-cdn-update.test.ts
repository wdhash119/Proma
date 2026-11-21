import { describe, expect, test } from 'bun:test'
import {
  cuaAssetLabel,
  CuaCdnCheckSchedule,
  DAY,
  fetchCuaCdnManifest,
  LABELS,
  MAX_ASSET_BYTES,
  parseCuaCdnManifest,
} from './computer-use-cdn-update'
import type { CuaCdnCheckStateIo, CuaCdnFetcher } from './computer-use-cdn-update'

const REAL_VERSION = '0.3.1'

/** 构造与真实 CDN 同构的清单样本。 */
function sampleManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: REAL_VERSION,
    assets: LABELS.map((label) => ({
      label,
      name: `cua-driver-rs-${REAL_VERSION}-${label}.${label.startsWith('windows-') ? 'zip' : 'tar.gz'}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
    })),
    ...overrides,
  }
}

function assetsOf(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return manifest.assets as Record<string, unknown>[]
}

describe('Cua CDN 清单解析', () => {
  test('Given 真实格式清单 When 解析 Then 返回规范化结果', () => {
    const parsed = parseCuaCdnManifest(sampleManifest())

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.version).toBe(REAL_VERSION)
    expect(parsed.assets).toHaveLength(6)
    expect(parsed.assets.map((asset) => asset.label)).toEqual([...LABELS])
    expect(parsed.assets[3]).toEqual({
      label: 'windows-x86_64',
      name: `cua-driver-rs-${REAL_VERSION}-windows-x86_64.zip`,
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
    })
  })

  test('Given 顶层出现多余字段 When 解析 Then 拒绝', () => {
    expect(() => parseCuaCdnManifest(sampleManifest({ extra: true }))).toThrow('Cua CDN 清单格式无效')
  })

  test('Given 顶层缺少 assets When 解析 Then 拒绝', () => {
    const manifest = sampleManifest()
    delete manifest.assets
    expect(() => parseCuaCdnManifest(manifest)).toThrow('Cua CDN 清单格式无效')
  })

  test('Given 清单不是对象 When 解析 Then 拒绝', () => {
    for (const value of [null, undefined, 'manifest', 42, []]) {
      expect(() => parseCuaCdnManifest(value)).toThrow('Cua CDN 清单格式无效')
    }
  })

  test('Given schemaVersion 不是 1 When 解析 Then 拒绝', () => {
    expect(() => parseCuaCdnManifest(sampleManifest({ schemaVersion: 2 }))).toThrow('Cua CDN 清单格式无效')
    expect(() => parseCuaCdnManifest(sampleManifest({ schemaVersion: '1' }))).toThrow('Cua CDN 清单格式无效')
  })

  test('Given 版本号不是三段数字 When 解析 Then 拒绝', () => {
    for (const version of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-beta.1', '1.0.0+build']) {
      expect(() => parseCuaCdnManifest(sampleManifest({ version }))).toThrow('Cua CDN 清单格式无效')
    }
  })

  test('Given 版本号超过长度上限 When 解析 Then 拒绝', () => {
    const version = `1.0.${'1'.repeat(58)}`
    expect(version.length).toBeGreaterThan(60)
    expect(() => parseCuaCdnManifest(sampleManifest({ version }))).toThrow('Cua CDN 清单格式无效')
  })

  test('Given 资产数量不是 6 When 解析 Then 拒绝', () => {
    const manifest = sampleManifest()
    expect(() => parseCuaCdnManifest({ ...manifest, assets: assetsOf(manifest).slice(0, 5) })).toThrow(
      'Cua CDN 清单格式无效',
    )
    expect(() => parseCuaCdnManifest({ ...manifest, assets: [...assetsOf(manifest), assetsOf(manifest)[0]] })).toThrow(
      'Cua CDN 清单格式无效',
    )
    expect(() => parseCuaCdnManifest({ ...manifest, assets: 'nope' })).toThrow('Cua CDN 清单格式无效')
  })

  test('Given 资产出现重复标签 When 解析 Then 拒绝', () => {
    const assets = assetsOf(sampleManifest())
    assets[1] = { ...assets[1], label: 'darwin-arm64' }
    expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产格式无效')
  })

  test('Given 资产标签未知 When 解析 Then 拒绝', () => {
    const assets = assetsOf(sampleManifest())
    assets[0] = { ...assets[0], label: 'freebsd-x86_64' }
    expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产格式无效')
  })

  test('Given 资产出现多余字段 When 解析 Then 拒绝', () => {
    const assets = assetsOf(sampleManifest())
    assets[0] = { ...assets[0], url: 'https://example.com' }
    expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产格式无效')
  })

  test('Given 摘要不是小写 64 位十六进制 When 解析 Then 拒绝', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 1]) {
      const assets = assetsOf(sampleManifest())
      assets[0] = { ...assets[0], sha256 }
      expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产格式无效')
    }
  })

  test('Given 体积不是正安全整数 When 解析 Then 拒绝', () => {
    for (const sizeBytes of [0, -1, 1.5, MAX_ASSET_BYTES + 1, '1024', Number.MAX_SAFE_INTEGER + 2]) {
      const assets = assetsOf(sampleManifest())
      assets[0] = { ...assets[0], sizeBytes }
      expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产格式无效')
    }
  })

  test('Given 资产名称与版本或扩展名不符 When 解析 Then 拒绝', () => {
    const cases = [
      `cua-driver-rs-0.3.0-darwin-arm64.tar.gz`,
      `cua-driver-rs-${REAL_VERSION}-darwin-arm64.zip`,
      `cua-driver-rs-${REAL_VERSION}-darwin-arm64`,
      `cua-driver-rs-${REAL_VERSION}-windows-arm64.tar.gz`,
      `Cua-Driver-RS-${REAL_VERSION}-darwin-arm64.tar.gz`,
    ]
    for (const name of cases) {
      const assets = assetsOf(sampleManifest())
      assets[0] = { ...assets[0], name }
      expect(() => parseCuaCdnManifest({ ...sampleManifest(), assets })).toThrow('Cua CDN 资产名称无效')
    }
  })
})

describe('平台标签映射', () => {
  test('Given 受支持平台与架构 When 映射 Then 返回清单标签', () => {
    expect(cuaAssetLabel('win32', 'x64')).toBe('windows-x86_64')
    expect(cuaAssetLabel('win32', 'arm64')).toBe('windows-arm64')
    expect(cuaAssetLabel('darwin', 'x64')).toBe('darwin-x86_64')
    expect(cuaAssetLabel('darwin', 'arm64')).toBe('darwin-arm64')
    expect(cuaAssetLabel('linux', 'x64')).toBe('linux-x86_64')
    expect(cuaAssetLabel('linux', 'arm64')).toBe('linux-arm64')
  })

  test('Given 清单未覆盖的组合 When 映射 Then 返回 undefined', () => {
    expect(cuaAssetLabel('win32', 'ia32')).toBeUndefined()
    expect(cuaAssetLabel('freebsd', 'x64')).toBeUndefined()
    expect(cuaAssetLabel('darwin', 'ppc64')).toBeUndefined()
    expect(cuaAssetLabel('aix', 'unknown')).toBeUndefined()
  })
})

/** 拼装一次性 fetch 替身，返回固定响应。 */
function fetcherReturning(response: Response, calls: string[] = []): CuaCdnFetcher {
  return async (url) => {
    calls.push(url)
    return response
  }
}

function responseWithUrl(body: BodyInit | null, url: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url })
  return response
}

const MANIFEST_URL = 'https://cdn.proma.cool/cua-driver/latest.yml'

describe('Cua CDN 清单拉取', () => {
  test('Given 正常响应 When 拉取 Then 解析出清单', async () => {
    const calls: string[] = []
    const manifest = await fetchCuaCdnManifest(
      fetcherReturning(responseWithUrl(JSON.stringify(sampleManifest()), MANIFEST_URL), calls),
    )

    expect(calls).toEqual([MANIFEST_URL])
    expect(manifest.version).toBe(REAL_VERSION)
  })

  test('Given 响应非 2xx When 拉取 Then 抛请求失败', async () => {
    await expect(
      fetchCuaCdnManifest(fetcherReturning(responseWithUrl('oops', MANIFEST_URL, { status: 503 }))),
    ).rejects.toThrow('Cua CDN 请求失败: HTTP 503')
  })

  test('Given 响应被重定向 When 拉取 Then 抛请求失败', async () => {
    const response = responseWithUrl(JSON.stringify(sampleManifest()), 'https://mirror.example.com/latest.yml')
    await expect(fetchCuaCdnManifest(fetcherReturning(response))).rejects.toThrow('Cua CDN 请求失败: HTTP 200')
  })

  test('Given 响应没有正文 When 拉取 Then 抛响应为空', async () => {
    await expect(
      fetchCuaCdnManifest(fetcherReturning(responseWithUrl(null, MANIFEST_URL))),
    ).rejects.toThrow('Cua CDN 响应为空')
  })

  test('Given 正文超过体积上限 When 拉取 Then 抛清单过大', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(70 * 1024) })
    await expect(
      fetchCuaCdnManifest(fetcherReturning(responseWithUrl(oversized, MANIFEST_URL))),
    ).rejects.toThrow('Cua CDN 清单过大')
  })

  test('Given 正文不是 JSON When 拉取 Then 抛格式无效', async () => {
    await expect(
      fetchCuaCdnManifest(fetcherReturning(responseWithUrl('not json', MANIFEST_URL))),
    ).rejects.toThrow('Cua CDN 清单格式无效')
  })
})

interface MemoryIo {
  files: Map<string, string>
  io: CuaCdnCheckStateIo
  setFailWrite: (value: boolean) => void
}

/** 内存文件系统替身：不触碰真实磁盘。 */
function createMemoryIo(initial: Record<string, string> = {}): MemoryIo {
  const files = new Map(Object.entries(initial))
  let failWrite = false
  return {
    files,
    io: {
      readText: (filePath) => files.get(filePath),
      writeText: (filePath, content) => {
        if (failWrite) throw new Error('磁盘不可写')
        files.set(filePath, content)
      },
    },
    setFailWrite: (value) => {
      failWrite = value
    },
  }
}

const STATE_PATH = '/virtual/proma/computer-use-update.json'

describe('检查调度', () => {
  test('Given 首次运行 When 计算下次检查 Then 落在 1 分钟后到 1 天内', () => {
    const { io } = createMemoryIo()
    const now = 1_700_000_000_000
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 0, io)

    expect(schedule.nextCheckAt).toBe(now + 60_000)
  })

  test('Given 抖动取整日上限 When 计算下次检查 Then 仍落在允许区间内', () => {
    const { io } = createMemoryIo()
    const now = 1_700_000_000_000
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => DAY - 1, io)

    expect(schedule.nextCheckAt).toBe(now + 60_000 + DAY - 1)
    expect(schedule.nextCheckAt).toBeLessThan(now + 60_000 + DAY)
  })

  test('Given 抖动非法 When 构造 Then 抛随机偏移无效', () => {
    for (const jitter of [() => -1, () => DAY, () => 1.5, () => Number.NaN]) {
      const { io } = createMemoryIo()
      expect(() => new CuaCdnCheckSchedule(STATE_PATH, Date.now, jitter, io)).toThrow('Cua 检查随机偏移无效')
    }
  })

  test('Given 磁盘已有合法调度 When 构造 Then 沿用并回写', () => {
    const now = 1_700_000_000_000
    const { io, files } = createMemoryIo({
      [STATE_PATH]: JSON.stringify({ schemaVersion: 1, nextCheckAt: now + 5_000 }),
    })
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 123, io)

    expect(schedule.nextCheckAt).toBe(now + 5_000)
    expect(JSON.parse(files.get(STATE_PATH)!)).toEqual({ schemaVersion: 1, nextCheckAt: now + 5_000 })
  })

  test('Given 状态文件损坏或超出容忍范围 When 构造 Then 回退到默认调度', () => {
    const now = 1_700_000_000_000
    const broken = [
      'not json',
      JSON.stringify({ schemaVersion: 2, nextCheckAt: now + 1_000 }),
      JSON.stringify({ schemaVersion: 1, nextCheckAt: now + 3 * DAY }),
      JSON.stringify({ schemaVersion: 1, nextCheckAt: -1 }),
      JSON.stringify({ schemaVersion: 1, nextCheckAt: 1.5 }),
      JSON.stringify({ schemaVersion: 1, nextCheckAt: '1700000000000' }),
      JSON.stringify([1, 2, 3]),
    ]

    for (const content of broken) {
      const { io } = createMemoryIo({ [STATE_PATH]: content })
      const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 500, io)
      expect(schedule.nextCheckAt).toBe(now + 60_000 + 500)
    }
  })

  test('Given 尚未到期 When 占用调度 Then 返回 false 并保持时间', () => {
    const now = 1_700_000_000_000
    const { io, files } = createMemoryIo({
      [STATE_PATH]: JSON.stringify({ schemaVersion: 1, nextCheckAt: now + 1_000 }),
    })
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 0, io)
    const before = schedule.nextCheckAt

    expect(schedule.claimIfDue()).toBe(false)
    expect(schedule.nextCheckAt).toBe(before)
    expect(JSON.parse(files.get(STATE_PATH)!).nextCheckAt).toBe(before)
  })

  test('Given 已到期 When 占用调度 Then 返回 true 并顺延一天', () => {
    const now = 1_700_000_000_000
    const { io, files } = createMemoryIo({
      [STATE_PATH]: JSON.stringify({ schemaVersion: 1, nextCheckAt: now - 1 }),
    })
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 0, io)

    expect(schedule.claimIfDue()).toBe(true)
    expect(schedule.nextCheckAt).toBe(now + DAY)
    expect(JSON.parse(files.get(STATE_PATH)!)).toEqual({ schemaVersion: 1, nextCheckAt: now + DAY })
  })

  test('Given 落盘失败 When 占用调度 Then 抛出并回退内存值', () => {
    const now = 1_700_000_000_000
    const memory = createMemoryIo({
      [STATE_PATH]: JSON.stringify({ schemaVersion: 1, nextCheckAt: now - 1 }),
    })
    const schedule = new CuaCdnCheckSchedule(STATE_PATH, () => now, () => 0, memory.io)
    const before = schedule.nextCheckAt
    memory.setFailWrite(true)

    expect(() => schedule.claimIfDue()).toThrow('磁盘不可写')
    expect(schedule.nextCheckAt).toBe(before)
  })
})
