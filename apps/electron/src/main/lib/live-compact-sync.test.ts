import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import * as bundledAlgorithm from '@proma/live-compact'
import { resolveLiveCompactAlgorithm, loadLiveCompactSourceModule } from './adapters/live-compact-algorithm-loader'
import {
  createLiveCompactSyncService,
  evaluateTarEntry,
  extractUpstreamBundle,
  getBundledSha,
  getBundledVersion,
  isUnsafeTarPath,
  LIVE_COMPACT_ALGORITHM_MODULES,
  MAX_RETAINED_VERSIONS,
  OVERRIDE_INDEX_SOURCE,
  parseActiveManifest,
  parsePersistedState,
  resolveLiveCompactSyncPaths,
  UPSTREAM_TARBALL_WHITELIST,
  type LiveCompactSyncDeps,
} from './live-compact-sync'
import { upstreamHeadUrl } from './live-compact-upstream'

const appRoot = join(import.meta.dir, '../../..')
const repoRoot = join(appRoot, '../..')
const vendoredPackageDir = join(repoRoot, 'packages/live-compact')

/** 用于同步的假上游 sha（40 位小写十六进制）。 */
const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
const OTHER_SHA = 'b'.repeat(40)
const FIXED_NOW = '2026-11-22T09:00:00.000Z'

const temporaryRoots: string[] = []

function createTemporaryDir(prefix = 'proma-live-compact-sync-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 构造带正确 url 的 HEAD 响应。 */
function headResponse(sha: string, date = '2026-11-16T12:34:56Z'): Response {
  const response = new Response(JSON.stringify({ sha, commit: { author: { date } } }), { status: 200 })
  Object.defineProperty(response, 'url', { value: upstreamHeadUrl() })
  return response
}

interface BundleOptions {
  version?: string
  rootName?: string
  /** 不写入的相对包内路径（用来造“缺少必需文件”）。 */
  omit?: readonly string[]
  /** 覆盖文件内容（键为相对包内路径）。 */
  replace?: Record<string, string>
  /** 额外文件（用来验证白名单丢弃）。 */
  extra?: Record<string, string>
}

interface BuiltBundle {
  tarballPath: string
  rootName: string
  bundleRoot: string
}

/**
 * 现场构造一个与上游同构的最小包并打成 tar.gz。
 *
 * 算法四件直接读 vendored 包的真实文件；测试文件也读真实内容，只把
 * `../src/` 改写成上游布局的 `../extensions/`（行为闸被注入替身时不实际执行）。
 */
async function buildBundle(options: BundleOptions = {}): Promise<BuiltBundle> {
  const root = createTemporaryDir('proma-live-compact-bundle-')
  const rootName = options.rootName ?? 'pi-live-compact-abcdef0'
  const bundleRoot = join(root, rootName)
  const omit = new Set(options.omit ?? [])

  mkdirSync(join(bundleRoot, 'extensions'), { recursive: true })
  mkdirSync(join(bundleRoot, 'tests'), { recursive: true })

  for (const name of LIVE_COMPACT_ALGORITHM_MODULES) {
    const relativePath = `extensions/${name}.ts`
    if (omit.has(relativePath)) continue
    writeFileSync(
      join(bundleRoot, relativePath),
      options.replace?.[relativePath] ?? readFileSync(join(vendoredPackageDir, 'src', `${name}.ts`), 'utf8'),
    )
  }
  for (const name of LIVE_COMPACT_ALGORITHM_MODULES) {
    const relativePath = `tests/${name}.test.ts`
    if (omit.has(relativePath)) continue
    const source = readFileSync(join(vendoredPackageDir, 'tests', `${name}.test.ts`), 'utf8')
    writeFileSync(
      join(bundleRoot, relativePath),
      options.replace?.[relativePath] ?? source.replaceAll('../src/', '../extensions/'),
    )
  }

  if (!omit.has('package.json')) {
    writeFileSync(
      join(bundleRoot, 'package.json'),
      options.replace?.['package.json']
        ?? JSON.stringify({ name: 'pi-live-compact', version: options.version ?? '0.13.0', type: 'module' }, null, 2),
    )
  }
  if (!omit.has('PORTING.md')) {
    writeFileSync(join(bundleRoot, 'PORTING.md'), options.replace?.['PORTING.md'] ?? '# 移植差异表\n')
  }
  for (const [relativePath, content] of Object.entries(options.extra ?? {})) {
    const target = join(bundleRoot, relativePath)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }

  const tarballPath = join(root, 'upstream.tar.gz')
  await tar.c({ gzip: true, cwd: root, file: tarballPath }, [rootName])
  return { tarballPath, rootName, bundleRoot }
}

/** 默认依赖：网络、下载、Bun 探测与测试执行全部替身；形状闸用真实 bundled 模块替身加速。 */
function baseDeps(tarballPath: string, overrides: LiveCompactSyncDeps = {}): LiveCompactSyncDeps {
  return {
    fetcher: async () => headResponse(HEAD_SHA),
    downloadTarball: async (_sha, destinationPath) => {
      copyFileSync(tarballPath, destinationPath)
      return { bytes: statSync(destinationPath).size, path: destinationPath }
    },
    loadModule: async () => bundledAlgorithm,
    detectBun: async () => ({ available: true, path: '/fake/bun' }),
    runAlgorithmTests: async () => ({ exitCode: 0, stdoutTail: '94 pass' }),
    now: () => new Date(FIXED_NOW),
    warn: () => undefined,
    ...overrides,
  }
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
}

describe('Live Compact 同步：bundled 基线', () => {
  test('Given 随包元数据 When 读取 Then 版本与 sha 来自 vendored 包', () => {
    expect(getBundledVersion()).toBe(readJson(join(vendoredPackageDir, 'package.json')).version as string)
    expect(getBundledSha()).toBe(readJson(join(vendoredPackageDir, 'UPSTREAM.json')).commit as string)
  })

  test('Given 覆盖层入口模板 When 与基线文件比对 Then 再导出行逐行一致（防漂移）', () => {
    const baseline = readFileSync(join(vendoredPackageDir, 'src', 'index.ts'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export '))
    const generated = OVERRIDE_INDEX_SOURCE
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export '))
    expect(generated).toEqual(baseline)
  })

  test('Given 解包白名单 When 检查 Then 只含算法四件、四份测试与两份元数据', () => {
    expect([...UPSTREAM_TARBALL_WHITELIST].sort()).toEqual(
      [
        'PORTING.md',
        'extensions/cooldown.ts',
        'extensions/plan.ts',
        'extensions/recall.ts',
        'extensions/select.ts',
        'package.json',
        'tests/cooldown.test.ts',
        'tests/plan.test.ts',
        'tests/recall.test.ts',
        'tests/select.test.ts',
      ].sort(),
    )
    // 宿主胶层与胶层测试永远不随同步替换。
    expect(UPSTREAM_TARBALL_WHITELIST as readonly string[]).not.toContain('extensions/live-compact.ts')
    expect(UPSTREAM_TARBALL_WHITELIST as readonly string[]).not.toContain('tests/handler.test.ts')
  })
})

describe('Live Compact 同步：状态读取', () => {
  test('Given 没有覆盖层 When 读状态 Then 只有 bundled 信息', async () => {
    const configDir = createTemporaryDir()
    const service = createLiveCompactSyncService({ configDir })
    const state = await service.getState()

    expect(state.bundledVersion).toBe(getBundledVersion())
    expect(state.bundledSha).toBe(getBundledSha())
    expect(state.active).toBeUndefined()
    expect(state.upstream).toBeUndefined()
    expect(state.lastError).toBeUndefined()
    expect(state.syncing).toBe(false)
  })

  test('Given active.json 损坏 When 读状态 Then 视为无覆盖层', async () => {
    const configDir = createTemporaryDir()
    const paths = resolveLiveCompactSyncPaths(configDir)
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.activeManifestPath, '{ not json')

    const service = createLiveCompactSyncService({ configDir })
    expect((await service.getState()).active).toBeUndefined()
  })

  test('Given active.json 缺字段 When 读状态 Then 视为无覆盖层', async () => {
    const configDir = createTemporaryDir()
    const paths = resolveLiveCompactSyncPaths(configDir)
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(paths.activeManifestPath, JSON.stringify({ version: '0.13.0', sha: HEAD_SHA }))

    const service = createLiveCompactSyncService({ configDir })
    expect((await service.getState()).active).toBeUndefined()
  })

  test('Given 清单指向不存在的目录 When 读状态 Then 视为无覆盖层', async () => {
    const configDir = createTemporaryDir()
    const paths = resolveLiveCompactSyncPaths(configDir)
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(
      paths.activeManifestPath,
      JSON.stringify({
        version: '0.13.0',
        sha: HEAD_SHA,
        syncedAt: FIXED_NOW,
        path: join(paths.versionsDir, '0.13.0-aaaaaaa'),
      }),
    )

    const service = createLiveCompactSyncService({ configDir })
    expect((await service.getState()).active).toBeUndefined()
  })

  test('Given 清单与目录都在 When 读状态 Then 返回覆盖层信息', async () => {
    const configDir = createTemporaryDir()
    const paths = resolveLiveCompactSyncPaths(configDir)
    const versionDir = join(paths.versionsDir, '0.13.0-aaaaaaa')
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(
      paths.activeManifestPath,
      JSON.stringify({ version: '0.13.0', sha: HEAD_SHA, syncedAt: FIXED_NOW, path: versionDir }),
    )

    const service = createLiveCompactSyncService({ configDir })
    expect((await service.getState()).active).toEqual({
      version: '0.13.0',
      sha: HEAD_SHA,
      syncedAt: FIXED_NOW,
      path: versionDir,
    })
  })

  test('Given 清单文本异常 When 解析 Then 缺任一字段即返回 undefined', () => {
    expect(parseActiveManifest(undefined)).toBeUndefined()
    expect(parseActiveManifest('[]')).toBeUndefined()
    expect(parseActiveManifest('null')).toBeUndefined()
    expect(parseActiveManifest(JSON.stringify({ version: ' ', sha: HEAD_SHA, syncedAt: FIXED_NOW, path: '/x' }))).toBeUndefined()
    expect(
      parseActiveManifest(JSON.stringify({ version: '0.13.0', sha: HEAD_SHA, syncedAt: FIXED_NOW, path: '/x' })),
    ).toEqual({ version: '0.13.0', sha: HEAD_SHA, syncedAt: FIXED_NOW, path: '/x' })
  })

  test('Given state.json 损坏 When 解析 Then 忽略非法条目', () => {
    expect(parsePersistedState(undefined)).toEqual({})
    expect(parsePersistedState('{')).toEqual({})
    expect(parsePersistedState(JSON.stringify({ lastCheck: { sha: HEAD_SHA } }))).toEqual({})
    expect(parsePersistedState(JSON.stringify({ lastError: '  ' }))).toEqual({})
    expect(
      parsePersistedState(JSON.stringify({ lastCheck: { sha: HEAD_SHA, date: FIXED_NOW, checkedAt: FIXED_NOW } })),
    ).toEqual({ lastCheck: { sha: HEAD_SHA, date: FIXED_NOW, checkedAt: FIXED_NOW } })
  })
})

describe('Live Compact 同步：白名单解包', () => {
  test('Given 上游同构包 When 解包 Then 保持 extensions/tests 原布局', async () => {
    const bundle = await buildBundle({ extra: { 'extensions/live-compact.ts': 'export default 1\n' } })
    const destination = join(createTemporaryDir(), 'package')

    await extractUpstreamBundle(bundle.tarballPath, destination)

    expect(readdirSync(destination).sort()).toEqual(['extensions', 'package.json', 'tests', 'PORTING.md'].sort())
    expect(readdirSync(join(destination, 'extensions')).sort()).toEqual(
      LIVE_COMPACT_ALGORITHM_MODULES.map((name) => `${name}.ts`).sort(),
    )
    expect(readdirSync(join(destination, 'tests')).sort()).toEqual(
      LIVE_COMPACT_ALGORITHM_MODULES.map((name) => `${name}.test.ts`).sort(),
    )
  })

  test('Given 包里含白名单外文件 When 解包 Then 丢弃而不报错', async () => {
    const bundle = await buildBundle({
      extra: {
        'extensions/live-compact.ts': 'export default 1\n',
        'tests/handler.test.ts': 'test\n',
        'README.md': '# readme\n',
      },
    })
    const destination = join(createTemporaryDir(), 'package')

    await extractUpstreamBundle(bundle.tarballPath, destination)

    expect(existsSync(join(destination, 'extensions', 'live-compact.ts'))).toBe(false)
    expect(existsSync(join(destination, 'tests', 'handler.test.ts'))).toBe(false)
    expect(existsSync(join(destination, 'README.md'))).toBe(false)
  })

  test('Given 缺少必需文件 When 解包 Then 报缺少必需文件', async () => {
    const bundle = await buildBundle({ omit: ['tests/cooldown.test.ts'] })
    const destination = join(createTemporaryDir(), 'package')

    await expect(extractUpstreamBundle(bundle.tarballPath, destination)).rejects.toThrow(
      '上游包缺少必需文件：tests/cooldown.test.ts',
    )
  })

  test('Given 含路径穿越条目 When 解包 Then 整包拒绝', async () => {
    const root = createTemporaryDir('proma-live-compact-traversal-')
    const packDir = join(root, 'pack')
    mkdirSync(join(packDir, 'pi-live-compact-evil', 'extensions'), { recursive: true })
    writeFileSync(join(packDir, 'pi-live-compact-evil', 'extensions', 'plan.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'outside.txt'), 'evil\n')
    const tarballPath = join(root, 'traversal.tar.gz')
    await tar.c({ gzip: true, cwd: packDir, file: tarballPath, preservePaths: true }, [
      'pi-live-compact-evil',
      '../outside.txt',
    ])

    const destination = join(createTemporaryDir(), 'package')
    await expect(extractUpstreamBundle(tarballPath, destination)).rejects.toThrow('路径穿越')
  })

  test('Given 各类异常条目路径 When 安全检查 Then 逐类拒绝', () => {
    expect(isUnsafeTarPath('/etc/passwd')).toBe('绝对路径')
    expect(isUnsafeTarPath('C:/windows/system32')).toBe('Windows 盘符绝对路径')
    expect(isUnsafeTarPath('a\\b')).toBe('路径含反斜杠')
    expect(isUnsafeTarPath('root/../../evil')).toBe('路径穿越（..）')
    expect(isUnsafeTarPath('root/extensions/plan.ts')).toBeUndefined()
  })

  test('Given 符号链接与硬链接条目 When 判定 Then 整包拒绝', () => {
    expect(evaluateTarEntry('root/extensions/plan.ts', 'SymbolicLink', undefined)).toEqual({
      action: 'reject',
      reason: 'tar 条目类型不受支持（SymbolicLink）：root/extensions/plan.ts',
    })
    expect(evaluateTarEntry('root/extensions/plan.ts', 'Link', undefined).action).toBe('reject')
    expect(evaluateTarEntry('root/dev/null', 'CharacterDevice', undefined).action).toBe('reject')
  })

  test('Given 多根目录条目 When 判定 Then 拒绝', () => {
    expect(evaluateTarEntry('other-root/extensions/plan.ts', 'File', 'pi-live-compact-abcdef0/')).toEqual({
      action: 'reject',
      reason: 'tar 条目根目录不一致：other-root/extensions/plan.ts',
    })
  })

  test('Given 目录与白名单外文件 When 判定 Then 跳过', () => {
    expect(evaluateTarEntry('root/', 'Directory', undefined).action).toBe('skip')
    expect(evaluateTarEntry('root/README.md', 'File', 'root/').action).toBe('skip')
    expect(evaluateTarEntry('root/extensions/plan.ts', 'File', 'root/')).toEqual({
      action: 'accept',
      relativePath: 'extensions/plan.ts',
    })
  })
})

describe('Live Compact 同步：happy path', () => {
  test('Given 三重闸全过 When 同步 Then 激活目录按契约组装并落 active.json', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '0.13.0' })
    // 形状闸用真实 jiti 加载 staging 四件：验证「闸里能加载」与覆盖层加载路径一致。
    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, { loadModule: loadLiveCompactSourceModule }),
    })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(true)

    const paths = resolveLiveCompactSyncPaths(configDir)
    const active = parseActiveManifest(readFileSync(paths.activeManifestPath, 'utf8'))
    expect(active).toEqual({
      version: '0.13.0',
      sha: HEAD_SHA,
      syncedAt: FIXED_NOW,
      path: join(paths.versionsDir, `0.13.0-${HEAD_SHA.slice(0, 7)}`),
    })

    const versionDir = active!.path
    expect(readdirSync(join(versionDir, 'src')).sort()).toEqual(
      [...LIVE_COMPACT_ALGORITHM_MODULES.map((name) => `${name}.ts`), 'index.ts'].sort(),
    )
    expect(existsSync(join(versionDir, 'package.json'))).toBe(true)
    expect(existsSync(join(versionDir, 'PORTING.md'))).toBe(true)
    expect(readJson(join(versionDir, 'UPSTREAM.json'))).toEqual({
      repo: 'https://github.com/carrotciallo/pi-live-compact',
      sha: HEAD_SHA,
      version: '0.13.0',
      syncedAt: FIXED_NOW,
    })
    // staging 必须清理干净。
    expect(readdirSync(paths.root).filter((name) => name.startsWith('staging-'))).toEqual([])

    const state = await service.getState()
    expect(state.active?.version).toBe('0.13.0')
    expect(state.syncing).toBe(false)
    expect(state.lastError).toBeUndefined()
    expect(state.upstream).toEqual({ sha: HEAD_SHA, date: '2026-11-16T12:34:56.000Z', checkedAt: FIXED_NOW })
  })

  test('Given 同步成功 When 用加载器解析 Then 走覆盖层而不是 bundled', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '0.13.0' })
    const service = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })
    expect((await service.syncUpstream()).ok).toBe(true)

    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: () => undefined })
    expect(resolved.source).toBe('override')
    expect(resolved.override?.version).toBe('0.13.0')
    expect(typeof resolved.algorithm.selectNewestChunk).toBe('function')
  })

  test('Given 同步失败后重试成功 When 读状态 Then lastError 被清除', async () => {
    const configDir = createTemporaryDir()
    const badBundle = await buildBundle({ version: '1.0' })
    const goodBundle = await buildBundle({ version: '0.13.0' })

    const failing = createLiveCompactSyncService({ configDir, deps: baseDeps(badBundle.tarballPath) })
    const failed = await failing.syncUpstream()
    expect(failed.ok).toBe(false)
    expect((await failing.getState()).lastError).toContain('版本闸失败')

    const succeeding = createLiveCompactSyncService({ configDir, deps: baseDeps(goodBundle.tarballPath) })
    expect((await succeeding.syncUpstream()).ok).toBe(true)
    const state = await succeeding.getState()
    expect(state.lastError).toBeUndefined()
    expect(state.active?.version).toBe('0.13.0')
  })
})

describe('Live Compact 同步：三重闸拒绝', () => {
  test('Given 上游版本号不是合法 SemVer When 同步 Then 版本闸拒绝且不激活', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '1.0' })
    const service = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('版本闸失败')
    expect(existsSync(resolveLiveCompactSyncPaths(configDir).activeManifestPath)).toBe(false)
    expect((await service.getState()).lastError).toContain('版本闸失败')
  })

  test('Given package.json 不是 JSON When 同步 Then 版本闸拒绝', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ replace: { 'package.json': 'not json' } })
    const service = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('不是合法 JSON')
  })

  test('Given 覆盖层导出缺项 When 同步 Then 形状闸拒绝且不激活', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({
      replace: { 'extensions/recall.ts': 'export const notRecall = 1\n' },
    })
    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, { loadModule: loadLiveCompactSourceModule }),
    })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('形状闸失败')
    expect(result.error).toContain('RecallStore')
    expect(existsSync(resolveLiveCompactSyncPaths(configDir).activeManifestPath)).toBe(false)
  })

  test('Given 上游测试未通过 When 同步 Then 行为闸拒绝并带出退出码', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle()
    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, {
        runAlgorithmTests: async () => ({ exitCode: 1, stdoutTail: '1 fail' }),
      }),
    })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('行为闸失败')
    expect(result.error).toContain('退出码 1')
    expect(result.state.lastError).toContain('行为闸失败')
  })

  test('Given 行为闸超时被杀 When 同步 Then 拒绝并说明超时', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle()
    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, {
        runAlgorithmTests: async () => ({ exitCode: null, timedOut: true }),
      }),
    })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('超时')
  })

  test('Given 没有可用的 Bun When 同步 Then 行为闸失败而不是跳过', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle()
    let testRuns = 0
    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, {
        detectBun: async () => ({ available: false, path: null }),
        runAlgorithmTests: async () => {
          testRuns++
          return { exitCode: 0 }
        },
      }),
    })

    const result = await service.syncUpstream()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当失败')
    expect(result.error).toContain('未检测到可用的 Bun 运行时')
    expect(testRuns).toBe(0)
  })

  test('Given 已有生效版本 When 新版本过闸失败 Then 保留现状', async () => {
    const configDir = createTemporaryDir()
    const good = await buildBundle({ version: '0.13.0' })
    const bad = await buildBundle({ version: '0.14.0' })

    const first = createLiveCompactSyncService({ configDir, deps: baseDeps(good.tarballPath) })
    expect((await first.syncUpstream()).ok).toBe(true)
    const beforeActive = readJson(resolveLiveCompactSyncPaths(configDir).activeManifestPath)

    const second = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bad.tarballPath, {
        runAlgorithmTests: async () => ({ exitCode: 2 }),
      }),
    })
    const failed = await second.syncUpstream()
    expect(failed.ok).toBe(false)

    const afterActive = readJson(resolveLiveCompactSyncPaths(configDir).activeManifestPath)
    expect(afterActive).toEqual(beforeActive)
    const state = await second.getState()
    expect(state.active?.version).toBe('0.13.0')
    expect(state.lastError).toContain('退出码 2')
  })
})

describe('Live Compact 同步：上游检查', () => {
  test('Given 上游 HEAD 等于随包基线 When 检查 Then 无更新', async () => {
    const configDir = createTemporaryDir()
    const baselineSha = getBundledSha()!
    const service = createLiveCompactSyncService({
      configDir,
      deps: { fetcher: async () => headResponse(baselineSha), now: () => new Date(FIXED_NOW), warn: () => undefined },
    })

    const checked = await service.checkUpstream()
    expect(checked).toEqual({
      sha: baselineSha,
      date: '2026-11-16T12:34:56.000Z',
      checkedAt: FIXED_NOW,
      updateAvailable: false,
    })
    expect((await service.getState()).upstream?.sha).toBe(baselineSha)
  })

  test('Given 上游 HEAD 前进 When 检查 Then 报有更新并落 state.json', async () => {
    const configDir = createTemporaryDir()
    const service = createLiveCompactSyncService({
      configDir,
      deps: { fetcher: async () => headResponse(HEAD_SHA), now: () => new Date(FIXED_NOW), warn: () => undefined },
    })

    const checked = await service.checkUpstream()
    expect(checked.updateAvailable).toBe(true)

    const persisted = readJson(resolveLiveCompactSyncPaths(configDir).statePath)
    expect(persisted.lastCheck).toEqual({ sha: HEAD_SHA, date: '2026-11-16T12:34:56.000Z', checkedAt: FIXED_NOW })
  })

  test('Given 已有覆盖层 When 检查 Then 与覆盖层 sha 比对', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '0.13.0' })
    const syncService = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })
    expect((await syncService.syncUpstream()).ok).toBe(true)

    const sameService = createLiveCompactSyncService({
      configDir,
      deps: { fetcher: async () => headResponse(HEAD_SHA), now: () => new Date(FIXED_NOW), warn: () => undefined },
    })
    expect((await sameService.checkUpstream()).updateAvailable).toBe(false)

    const movedService = createLiveCompactSyncService({
      configDir,
      deps: { fetcher: async () => headResponse(OTHER_SHA), now: () => new Date(FIXED_NOW), warn: () => undefined },
    })
    expect((await movedService.checkUpstream()).updateAvailable).toBe(true)
  })

  test('Given 网络失败 When 检查 Then 抛请求失败且不改 state.json', async () => {
    const configDir = createTemporaryDir()
    const service = createLiveCompactSyncService({
      configDir,
      deps: {
        fetcher: async () => {
          const response = new Response('boom', { status: 500 })
          Object.defineProperty(response, 'url', { value: upstreamHeadUrl() })
          return response
        },
      },
    })

    await expect(service.checkUpstream()).rejects.toThrow('上游请求失败: HTTP 500')
    expect(existsSync(resolveLiveCompactSyncPaths(configDir).statePath)).toBe(false)
  })
})

describe('Live Compact 同步：并发与版本保留', () => {
  test('Given 同步进行中 When 重复调用 Then 共享同一 Promise 且只下载一次', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '0.13.0' })
    let downloads = 0
    let releaseDownload: (() => void) | undefined
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve
    })
    let downloadStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve
    })

    const service = createLiveCompactSyncService({
      configDir,
      deps: baseDeps(bundle.tarballPath, {
        downloadTarball: async (_sha, destinationPath) => {
          downloads++
          downloadStarted?.()
          await downloadGate
          copyFileSync(bundle.tarballPath, destinationPath)
          return { bytes: statSync(destinationPath).size, path: destinationPath }
        },
      }),
    })

    const first = service.syncUpstream()
    const second = service.syncUpstream()
    expect(second).toBe(first)

    await started
    const duringState = await service.getState()
    expect(duringState.syncing).toBe(true)

    releaseDownload?.()
    const result = await first
    expect(result.ok).toBe(true)
    expect(downloads).toBe(1)
    expect((await service.getState()).syncing).toBe(false)
  })

  test('Given 连续同步三个版本 When 清理 Then 只保留最近两个版本目录', async () => {
    const configDir = createTemporaryDir()
    const paths = resolveLiveCompactSyncPaths(configDir)

    const versions = ['0.13.0', '0.14.0', '0.15.0']
    for (const [index, version] of versions.entries()) {
      const bundle = await buildBundle({ version })
      const service = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })
      const result = await service.syncUpstream()
      expect(result.ok).toBe(true)
      // mtime 决定保留顺序；显式错开，避免同一毫秒内三次同步造成排序不确定。
      const active = parseActiveManifest(readFileSync(paths.activeManifestPath, 'utf8'))
      const stamp = new Date(Date.UTC(2026, 10, 22, 9, 0, index))
      utimesSync(active!.path, stamp, stamp)
    }

    const retained = readdirSync(paths.versionsDir).sort()
    expect(retained).toEqual([
      `0.14.0-${HEAD_SHA.slice(0, 7)}`,
      `0.15.0-${HEAD_SHA.slice(0, 7)}`,
    ])
    expect(retained.length).toBe(MAX_RETAINED_VERSIONS)

    const service = createLiveCompactSyncService({ configDir })
    expect((await service.getState()).active?.version).toBe('0.15.0')
  })
})

describe('Live Compact 同步：回退内置版本', () => {
  test('Given 已同步覆盖层 When 回退 Then 删 active.json 但保留版本目录', async () => {
    const configDir = createTemporaryDir()
    const bundle = await buildBundle({ version: '0.13.0' })
    const service = createLiveCompactSyncService({ configDir, deps: baseDeps(bundle.tarballPath) })
    expect((await service.syncUpstream()).ok).toBe(true)

    const paths = resolveLiveCompactSyncPaths(configDir)
    const versionDir = parseActiveManifest(readFileSync(paths.activeManifestPath, 'utf8'))!.path

    const state = await service.resetToBundled()
    expect(state.active).toBeUndefined()
    expect(existsSync(paths.activeManifestPath)).toBe(false)
    expect(existsSync(versionDir)).toBe(true)

    const resolved = await resolveLiveCompactAlgorithm(configDir, { warn: () => undefined })
    expect(resolved.source).toBe('bundled')
  })

  test('Given 从未同步 When 回退 Then 幂等返回 bundled 状态', async () => {
    const configDir = createTemporaryDir()
    const service = createLiveCompactSyncService({ configDir })
    const state = await service.resetToBundled()
    expect(state.active).toBeUndefined()
    expect(state.bundledVersion).toBe(getBundledVersion())
  })
})
