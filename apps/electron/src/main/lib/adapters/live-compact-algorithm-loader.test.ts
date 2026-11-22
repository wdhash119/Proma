import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as bundledAlgorithm from '@proma/live-compact'
import {
  REQUIRED_ALGORITHM_EXPORTS,
  resolveLiveCompactAlgorithm,
  resolveLiveCompactManifestPath,
  validateAlgorithmShape,
  type LiveCompactAlgorithmLoaderDeps,
} from './live-compact-algorithm-loader'

const temporaryRoots: string[] = []

function createConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-live-compact-config-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeManifest(configDir: string, content: string): string {
  const dir = join(configDir, 'live-compact')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'active.json')
  writeFileSync(path, content)
  return path
}

function manifestFor(versionDir: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '0.12.0',
    sha: 'abcdef1234567890',
    syncedAt: '2026-11-22T10:00:00.000Z',
    path: versionDir,
    ...overrides,
  })
}

/** 只覆盖需要观察的依赖，其余走真实实现。 */
function deps(overrides: LiveCompactAlgorithmLoaderDeps): LiveCompactAlgorithmLoaderDeps {
  return { warn: () => undefined, ...overrides }
}

describe('Live Compact 算法加载器：bundled 基线', () => {
  test('Given 没有 active.json When 解析 Then 使用 bundled 且不产生告警', async () => {
    const configDir = createConfigDir()
    const warnings: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: (m) => warnings.push(m) })
    expect(resolved.source).toBe('bundled')
    expect(resolved.override).toBeUndefined()
    expect(resolved.warning).toBeUndefined()
    expect(warnings).toHaveLength(0)
    // bundled 就是随包的 @proma/live-compact：用它的一个纯函数证明可用。
    expect(resolved.algorithm.estimateTokens('hello world')).toBe(3)
    expect(typeof resolved.algorithm.selectNewestChunk).toBe('function')
    expect(typeof resolved.algorithm.RecallStore).toBe('function')
  })

  test('Given active.json 损坏 When 解析 Then 回落 bundled 并告警', async () => {
    const configDir = createConfigDir()
    writeManifest(configDir, '{ this is not json')
    const warnings: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: (m) => warnings.push(m) })
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('JSON 解析失败')
    expect(warnings).toHaveLength(1)
  })

  test('Given active.json 缺字段 When 解析 Then 回落 bundled 并指出缺失字段', async () => {
    const configDir = createConfigDir()
    writeManifest(configDir, JSON.stringify({ version: '0.12.0', sha: 'abc' }))
    const warnings: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: (m) => warnings.push(m) })
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('syncedAt')
    expect(resolved.warning).toContain('path')
  })

  test('Given active.json 是不可读的目录 When 解析 Then 回落 bundled 并告警', async () => {
    const configDir = createConfigDir()
    // 把 active.json 造成目录：readFile 会以 EISDIR 失败，走“不可读”分支。
    mkdirSync(join(configDir, 'live-compact', 'active.json'), { recursive: true })
    const warnings: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: (m) => warnings.push(m) })
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('清单不可读')
    expect(warnings).toHaveLength(1)
  })

  test('Given 清单路径 When 拼装 Then 落在 <configDir>/live-compact/active.json', () => {
    expect(resolveLiveCompactManifestPath('/tmp/proma')).toBe(join('/tmp/proma', 'live-compact', 'active.json'))
  })
})

describe('Live Compact 算法加载器：覆盖层', () => {
  test('Given 有效清单与可加载覆盖层 When 解析 Then 使用覆盖层并带上清单信息', async () => {
    const configDir = createConfigDir()
    const versionDir = join(configDir, 'live-compact', 'versions', '0.12.0-abcdef1')
    mkdirSync(join(versionDir, 'src'), { recursive: true })
    writeManifest(configDir, manifestFor(versionDir))

    const seenEntries: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, deps({
      loadOverrideModule: async (entryPath) => {
        seenEntries.push(entryPath)
        // 用 bundled 的导出做底座，替换一个函数以证明走的确实是覆盖层。
        return { ...bundledAlgorithm, estimateTokens: () => 4242 }
      },
    }))
    expect(resolved.source).toBe('override')
    expect(resolved.override?.version).toBe('0.12.0')
    expect(resolved.override?.sha).toBe('abcdef1234567890')
    expect(resolved.algorithm.estimateTokens('anything')).toBe(4242)
    expect(seenEntries[0]).toBe(join(versionDir, 'src', 'index.ts'))
  })

  test('Given 覆盖层缺必需导出 When 解析 Then 拒绝覆盖层并回落 bundled', async () => {
    const configDir = createConfigDir()
    const versionDir = join(configDir, 'live-compact', 'versions', '0.12.0-abcdef1')
    writeManifest(configDir, manifestFor(versionDir))
    const warnings: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, {
      warn: (m) => warnings.push(m),
      loadOverrideModule: async () => ({ ...bundledAlgorithm, selectNewestChunk: undefined }),
    })
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('selectNewestChunk')
    expect(warnings).toHaveLength(1)
  })

  test('Given 覆盖层 RecallStore 缺方法 When 解析 Then 拒绝覆盖层', async () => {
    const configDir = createConfigDir()
    const versionDir = join(configDir, 'live-compact', 'versions', '0.12.0-abcdef1')
    writeManifest(configDir, manifestFor(versionDir))
    class BrokenRecallStore {}
    const resolved = await resolveLiveCompactAlgorithm(configDir, deps({
      loadOverrideModule: async () => ({ ...bundledAlgorithm, RecallStore: BrokenRecallStore }),
    }))
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('RecallStore')
  })

  test('Given 覆盖层无法加载 When 解析 Then 回落 bundled 并记录所有入口错误', async () => {
    const configDir = createConfigDir()
    const versionDir = join(configDir, 'live-compact', 'versions', '0.12.0-abcdef1')
    writeManifest(configDir, manifestFor(versionDir))
    const resolved = await resolveLiveCompactAlgorithm(configDir, deps({
      loadOverrideModule: async (entryPath) => {
        throw new Error(`ENOENT ${entryPath}`)
      },
    }))
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('覆盖层加载失败')
    expect(resolved.warning).toContain(join('src', 'index.ts'))
    expect(resolved.warning).toContain(join('index.ts'))
  })

  test('Given src/index.ts 缺失但根 index.ts 可用 When 解析 Then 使用第二个候选入口', async () => {
    const configDir = createConfigDir()
    const versionDir = join(configDir, 'live-compact', 'versions', '0.12.0-abcdef1')
    writeManifest(configDir, manifestFor(versionDir))
    const attempted: string[] = []
    const resolved = await resolveLiveCompactAlgorithm(configDir, deps({
      loadOverrideModule: async (entryPath) => {
        attempted.push(entryPath)
        if (entryPath.endsWith(join('src', 'index.ts'))) throw new Error('ENOENT')
        return { ...bundledAlgorithm, estimateTokens: () => 7 }
      },
    }))
    expect(resolved.source).toBe('override')
    expect(resolved.algorithm.estimateTokens('x')).toBe(7)
    expect(attempted).toHaveLength(2)
  })

  test('Given 覆盖层版本非字符串 When 解析 Then 按字段缺失回落 bundled', async () => {
    const configDir = createConfigDir()
    writeManifest(configDir, JSON.stringify({ version: 12, sha: 'abc', syncedAt: 't', path: '/x' }))
    const resolved = await resolveLiveCompactAlgorithm(configDir, deps({
      loadOverrideModule: async () => bundledAlgorithm,
    }))
    expect(resolved.source).toBe('bundled')
    expect(resolved.warning).toContain('version')
  })
})

describe('Live Compact 算法加载器：形状闸', () => {
  test('Given bundled 模块 When 校验 Then 全部必需导出命中', () => {
    const validation = validateAlgorithmShape(bundledAlgorithm)
    expect('algorithm' in validation).toBe(true)
  })

  test('Given 必需导出清单 When 与实际消费面比对 Then 覆盖胶层用到的算法入口', () => {
    expect([...REQUIRED_ALGORITHM_EXPORTS].sort() as string[]).toEqual(
      [
        'RecallStore',
        'backgroundJobId',
        'callCommand',
        'callFilePath',
        'createOfficialCompactionTracker',
        'estimateTokens',
        'fallbackProviderURL',
        'inCooldownWindow',
        'latestOfficialCompaction',
        'lookupProviderURL',
        'recallHint',
        'recallResult',
        'resolveEngine',
        'selectNewestChunk',
      ].sort(),
    )
  })

  test('Given 非对象 When 校验 Then 报告全部缺失', () => {
    const validation = validateAlgorithmShape(null)
    expect('missing' in validation).toBe(true)
    if ('missing' in validation) {
      expect(validation.missing).toHaveLength(REQUIRED_ALGORITHM_EXPORTS.length)
    }
  })

  test('Given 导出是函数但声明为常量 When 校验 Then 仍通过（形状只查胶层实际调用面）', () => {
    // plan.ts 的 MARK/RAIL_TOKENS 等常量不在必需清单里：胶层不消费它们，
    // 同步覆盖层换掉常量值不会让胶层报错，由算法自己的测试闸把关。
    const validation = validateAlgorithmShape({ ...bundledAlgorithm })
    expect('algorithm' in validation).toBe(true)
    expect(REQUIRED_ALGORITHM_EXPORTS).not.toContain('MARK')
  })
})
