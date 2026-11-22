/**
 * Live Compact 上游同步服务：检查 → 下载 → 三重闸 → 原子激活 → 回退。
 *
 * 目录契约（`<configDir>/live-compact/`，configDir 由主进程用 `getConfigDir()` 给出）：
 *
 * ```
 * live-compact/
 *   active.json                 {version, sha, syncedAt, path}；缺省/损坏 = 使用 bundled
 *   state.json                  {lastCheck?, lastError?}；只做展示，不参与决策
 *   versions/<version>-<sha7>/  激活目录（见下）
 *     src/{plan,select,cooldown,recall}.ts   上游算法四件
 *     src/index.ts                           Proma 的再导出入口（加载器首选入口）
 *     package.json / PORTING.md / UPSTREAM.json
 * ```
 *
 * 为什么 staging 与激活目录布局不同：
 * - staging 必须保持**上游原布局**（`extensions/` + `tests/`），因为上游测试用
 *   `import "../extensions/plan.ts"` 相互引用，改布局就等于换了被测代码；
 * - 激活目录必须带 Proma 的 `src/index.ts` 再导出，这是 P2a 加载器的入口约定
 *   （覆盖层按 `src/index.ts` → `index.ts` 顺序找入口）。
 *
 * 三重闸（全部通过才允许激活）：
 * a. 版本闸：`package.json.version` 必须是合法 SemVer；
 * b. 形状闸：jiti 加载 staging 四件，导出并集必须覆盖胶层消费的
 *    `REQUIRED_ALGORITHM_EXPORTS`（复用加载器的 `validateAlgorithmShape`）；
 * c. 行为闸：用随包 Bun 在 staging 跑上游四份算法测试，退出码必须为 0。
 *
 * 任一闸失败 → 拒绝激活、保留现状、清理 staging、把中文原因写进 `state.json.lastError`。
 * 本批不含 IPC / 设置页 / 运行时接线；调用方（P3b 的 handler）只消费本服务的四个方法。
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { valid as validSemver } from 'semver'
import type {
  LiveCompactActiveManifest,
  LiveCompactCheckRecord,
  LiveCompactCheckResult,
  LiveCompactState,
  LiveCompactSyncResult,
} from '@proma/shared'
import bundledPackage from '@proma/live-compact/package.json' with { type: 'json' }
import bundledUpstream from '@proma/live-compact/UPSTREAM.json' with { type: 'json' }
import {
  loadLiveCompactSourceModule,
  validateAlgorithmShape,
} from './adapters/live-compact-algorithm-loader'
import { writeJsonFileAtomic } from './safe-file'
import {
  downloadUpstreamTarball,
  fetchUpstreamHead,
  UPSTREAM_REPO,
  type LiveCompactDownloadResult,
  type LiveCompactFetcher,
} from './live-compact-upstream'

/**
 * 类型出口：契约形状已在 P3b 提取到 `@proma/shared`（IPC 四层共用同一份定义），
 * 这里保留再导出，避免既有调用方与测试改导入路径。
 */
export type {
  LiveCompactActiveManifest,
  LiveCompactCheckRecord,
  LiveCompactCheckResult,
  LiveCompactState,
  LiveCompactSyncResult,
}

/** 上游算法模块名（staging 里位于 `extensions/`，激活后位于 `src/`）。 */
export const LIVE_COMPACT_ALGORITHM_MODULES = ['plan', 'select', 'cooldown', 'recall'] as const

/** 上游算法测试文件名（staging 里位于 `tests/`）。 */
export const LIVE_COMPACT_ALGORITHM_TESTS = [
  'tests/plan.test.ts',
  'tests/select.test.ts',
  'tests/recall.test.ts',
  'tests/cooldown.test.ts',
] as const

/**
 * 解包白名单：从上游 tarball 里只取这些路径（相对包根，`<repo>-<sha>/` 之下）。
 *
 * 取舍依据：算法四件是同步对象；四份测试是行为闸的被测代码；`package.json` 提供版本号；
 * `PORTING.md` 是上游移植差异表，随版本存一份便于事后核对。宿主胶层
 * `extensions/live-compact.ts` 故意不在白名单内——胶层永远随 App 发版。
 */
export const UPSTREAM_TARBALL_WHITELIST = [
  ...LIVE_COMPACT_ALGORITHM_MODULES.map((name) => `extensions/${name}.ts`),
  ...LIVE_COMPACT_ALGORITHM_TESTS,
  'package.json',
  'PORTING.md',
] as const

/** 激活目录最多保留的版本数（当前 + 上一版，供回滚）。 */
export const MAX_RETAINED_VERSIONS = 2

/** 行为闸超时：上游 94 例测试实测约 300ms，120s 只用于兜底卡死。 */
export const ALGORITHM_TEST_TIMEOUT_MS = 120_000

/** 单个白名单文件的体积上限（上游最大文件约 52KB，2MB 仅作异常兜底）。 */
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024

/** 白名单条目累计体积上限（防御解压炸弹）。 */
const MAX_TOTAL_EXTRACT_BYTES = 8 * 1024 * 1024

/**
 * 激活目录入口 `src/index.ts` 的源码。
 *
 * 内容与 `packages/live-compact/src/index.ts` 的再导出段落一致：覆盖层入口必须导全
 * 四件算法的导出，加载器的形状闸才可能过。测试里有一条守卫会把这个字符串与基线文件
 * 的导出行逐行比对，防止两处漂移。
 */
export const OVERRIDE_INDEX_SOURCE = [
  '// @proma/live-compact 覆盖层统一出口（同步服务生成，勿手改）。',
  '//',
  '// 内容与 packages/live-compact/src/index.ts 的再导出段落一致：只做再导出，不写业务逻辑。',
  ...LIVE_COMPACT_ALGORITHM_MODULES.map((name) => `export * from "./${name}.ts";`),
  '',
].join('\n')

/** `state.json` 的落盘形状。 */
interface LiveCompactPersistedState {
  lastCheck?: LiveCompactCheckRecord
  lastError?: string
}

/** Bun 运行时探测结果（只取行为闸需要的三个字段）。 */
export interface LiveCompactBunRuntime {
  available: boolean
  path: string | null
  version?: string | null
}

/** 行为闸执行入参。 */
export interface LiveCompactTestRunInput {
  bunPath: string
  workingDir: string
  testFiles: readonly string[]
}

/** 行为闸执行结果。 */
export interface LiveCompactTestRunResult {
  exitCode: number | null
  timedOut?: boolean
  stdoutTail?: string
  stderrTail?: string
}

/**
 * 依赖注入面：测试替换网络、下载、解包、模块加载、Bun 探测与测试执行。
 * 全部可选，缺省走真实实现。
 */
export interface LiveCompactSyncDeps {
  fetcher?: LiveCompactFetcher
  downloadTarball?: (sha: string, destinationPath: string) => Promise<LiveCompactDownloadResult>
  extractBundle?: (tarballPath: string, destinationDir: string) => Promise<void>
  loadModule?: (entryPath: string) => Promise<unknown>
  detectBun?: () => Promise<LiveCompactBunRuntime>
  runAlgorithmTests?: (input: LiveCompactTestRunInput) => Promise<LiveCompactTestRunResult>
  /** 时钟注入：固定 `syncedAt` / `checkedAt`，便于断言。 */
  now?: () => Date
  warn?: (message: string) => void
}

export interface LiveCompactSyncPaths {
  /** `<configDir>/live-compact`。 */
  root: string
  activeManifestPath: string
  statePath: string
  versionsDir: string
}

export interface LiveCompactSyncOptions {
  configDir: string
  deps?: LiveCompactSyncDeps
}

/** 同步服务对外接口（P3b 的四个 IPC 方法一一对应）。 */
export interface LiveCompactSyncService {
  getState: () => Promise<LiveCompactState>
  checkUpstream: () => Promise<LiveCompactCheckResult>
  syncUpstream: () => Promise<LiveCompactSyncResult>
  resetToBundled: () => Promise<LiveCompactState>
}

/** 覆盖层状态目录的固定路径（加载器只认 active.json，其余是本服务私有）。 */
export function resolveLiveCompactSyncPaths(configDir: string): LiveCompactSyncPaths {
  const root = join(configDir, 'live-compact')
  return {
    root,
    activeManifestPath: join(root, 'active.json'),
    statePath: join(root, 'state.json'),
    versionsDir: join(root, 'versions'),
  }
}

/** 随 App 发版的算法版本。 */
export function getBundledVersion(): string {
  return String(bundledPackage.version)
}

/** 随 App 发版对应的上游 commit sha（UPSTREAM.json 的 commit 字段）。 */
export function getBundledSha(): string | undefined {
  const commit = (bundledUpstream as Record<string, unknown>).commit
  return typeof commit === 'string' && commit.length > 0 ? commit : undefined
}

/**
 * 解析 `active.json`。
 *
 * 判定口径与加载器保持一致（四个字段都是非空字符串才算清单）：两者不一致会出现
 * 「设置页说没有覆盖层、运行时却在用覆盖层」这类互相矛盾的状态。sha 这里不校验
 * 长度，因为加载器也不校验，同步写出的 sha 则由上游客户端保证是 40 位 hex。
 */
export function parseActiveManifest(text: string | undefined): LiveCompactActiveManifest | undefined {
  if (text === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const sha = typeof record.sha === 'string' ? record.sha.trim() : ''
  const syncedAt = typeof record.syncedAt === 'string' ? record.syncedAt.trim() : ''
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (!version || !sha || !syncedAt || !path) return undefined
  return { version, sha, syncedAt, path }
}

/** 解析 `state.json`；损坏条目按缺失处理（state 只是展示缓存）。 */
export function parsePersistedState(text: string | undefined): LiveCompactPersistedState {
  if (text === undefined) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const result: LiveCompactPersistedState = {}

  const lastCheck = record.lastCheck
  if (typeof lastCheck === 'object' && lastCheck !== null && !Array.isArray(lastCheck)) {
    const check = lastCheck as Record<string, unknown>
    const sha = typeof check.sha === 'string' ? check.sha : ''
    const date = typeof check.date === 'string' ? check.date : ''
    const checkedAt = typeof check.checkedAt === 'string' ? check.checkedAt : ''
    if (sha && date && checkedAt) result.lastCheck = { sha, date, checkedAt }
  }

  const lastError = record.lastError
  if (typeof lastError === 'string' && lastError.trim().length > 0) {
    result.lastError = lastError.trim()
  }
  return result
}

/**
 * 判断 tar 条目是否安全，并给出处理动作。
 *
 * 安全判定是**整包级**的：命中路径穿越、绝对路径、符号/硬链接的条目不是「跳过」，
 * 而是让整次同步失败——能构造出这类条目的 tarball 本身不可信，继续用它的其它文件
 * 没有意义。
 */
export type TarEntryAction =
  | { action: 'accept'; relativePath: string }
  | { action: 'skip'; reason: string }
  | { action: 'reject'; reason: string }

/** 合法条目类型：只接受普通文件（Directory 跳过，其余一律拒绝）。 */
const ACCEPTED_ENTRY_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])

/**
 * 路径安全检查：拒绝绝对路径（POSIX 与 Windows 盘符）、`..` 段、反斜杠与空段。
 * `rawPath` 是 tar 头里的原始路径（POSIX 风格）。
 */
export function isUnsafeTarPath(rawPath: string): string | undefined {
  if (rawPath.length === 0) return '路径为空'
  if (rawPath.startsWith('/')) return '绝对路径'
  if (/^[a-zA-Z]:/.test(rawPath)) return 'Windows 盘符绝对路径'
  if (rawPath.includes('\\')) return '路径含反斜杠'
  const segments = rawPath.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '..')) return '路径穿越（..）'
  return undefined
}

/**
 * 按「根目录前缀 + 白名单 + 类型」判定单个条目。
 *
 * GitHub tarball 的条目形如 `pi-live-compact-<sha>/extensions/plan.ts`：先剥掉唯一的
 * 顶层目录，再按白名单匹配相对路径。顶层目录不一致（多根）视为不可信包。
 */
export function evaluateTarEntry(
  rawPath: string,
  entryType: string,
  rootPrefix: string | undefined,
): TarEntryAction {
  const unsafe = isUnsafeTarPath(rawPath)
  if (unsafe) return { action: 'reject', reason: `tar 条目路径不安全（${unsafe}）：${rawPath}` }

  if (entryType === 'Directory' || entryType === 'GNUDumpDir') {
    return { action: 'skip', reason: '目录条目' }
  }
  if (!ACCEPTED_ENTRY_TYPES.has(entryType)) {
    return { action: 'reject', reason: `tar 条目类型不受支持（${entryType}）：${rawPath}` }
  }

  const normalized = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const separator = normalized.indexOf('/')
  if (separator < 0) {
    return { action: 'reject', reason: `tar 条目不在单一根目录下：${rawPath}` }
  }
  const entryRoot = normalized.slice(0, separator)
  const prefix = rootPrefix ?? `${entryRoot}/`
  if (!prefix.startsWith(`${entryRoot}/`)) {
    return { action: 'reject', reason: `tar 条目根目录不一致：${rawPath}` }
  }
  const relativePath = normalized.slice(prefix.length)
  if (!relativePath) {
    return { action: 'reject', reason: `tar 条目缺少包内路径：${rawPath}` }
  }
  if (!(UPSTREAM_TARBALL_WHITELIST as readonly string[]).includes(relativePath)) {
    return { action: 'skip', reason: '不在白名单内' }
  }
  return { action: 'accept', relativePath }
}

/**
 * 白名单解包：先列出全部条目做安全与白名单判定，再按允许清单解压。
 *
 * 两阶段的意义：tar 的 `filter` 只能「跳过」，无法表达「整包拒绝」。先列后验让
 * 安全违规以异常形式中断同步，而不是被静默丢弃。
 */
export async function extractUpstreamBundle(tarballPath: string, destinationDir: string): Promise<void> {
  const tar = await import('tar')

  const entries: Array<{ path: string; type: string; size: number }> = []
  await tar.t({
    file: tarballPath,
    gzip: true,
    strict: true,
    onReadEntry: (entry) => {
      entries.push({ path: entry.path, type: entry.type, size: entry.size ?? 0 })
    },
  })

  let rootPrefix: string | undefined
  const accepted = new Set<string>()
  let totalBytes = 0
  for (const entry of entries) {
    const decision = evaluateTarEntry(entry.path, entry.type, rootPrefix)
    if (decision.action === 'reject') throw new Error(decision.reason)
    if (decision.action === 'skip') continue
    if (rootPrefix === undefined) {
      rootPrefix = `${entry.path.split('/')[0]}/`
    }
    if (entry.size > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`上游文件超过 ${MAX_SINGLE_FILE_BYTES} 字节上限：${decision.relativePath}`)
    }
    totalBytes += entry.size
    if (totalBytes > MAX_TOTAL_EXTRACT_BYTES) {
      throw new Error(`上游解包内容超过 ${MAX_TOTAL_EXTRACT_BYTES} 字节上限`)
    }
    accepted.add(decision.relativePath)
  }

  if (accepted.size === 0) throw new Error('上游 tarball 里没有白名单内的文件')

  await mkdir(destinationDir, { recursive: true })
  await tar.x({
    file: tarballPath,
    gzip: true,
    cwd: destinationDir,
    strict: true,
    // 单一顶层目录已在上一阶段校验（多根会被拒），这里直接剥掉一层还原包内布局。
    strip: 1,
    filter: (entryPath: string) => {
      const normalized = entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath
      const separator = normalized.indexOf('/')
      if (separator < 0) return false
      return accepted.has(normalized.slice(separator + 1))
    },
  })

  const missing = UPSTREAM_TARBALL_WHITELIST.filter((relativePath) => !accepted.has(relativePath))
  if (missing.length > 0) {
    throw new Error(`上游包缺少必需文件：${missing.join(', ')}`)
  }
}

/** 默认实现：Bun 探测（bun-finder，动态导入避免测试因 electron 依赖而无法加载本模块）。 */
async function defaultDetectBun(): Promise<LiveCompactBunRuntime> {
  const { detectBunRuntime } = await import('./bun-finder')
  const status = await detectBunRuntime()
  return { available: status.available, path: status.path, version: status.version }
}

/**
 * 行为闸子进程的环境：剥掉 `SPINE_*`。
 *
 * 上游算法在模块加载时读这些 env 求值模块级常量（阈值、冷却、让位开关）；带着
 * 宿主进程的 SPINE_* 跑测试，闸的结果就取决于当前机器怎么配的，不能证明包的默认行为。
 */
function algorithmTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SPINE_')) continue
    env[key] = value
  }
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

/** 默认实现：spawn `bun test <四份测试>`，保留输出尾部用于失败诊断。 */
function defaultRunAlgorithmTests(input: LiveCompactTestRunInput): Promise<LiveCompactTestRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.bunPath, ['test', ...input.testFiles], {
      cwd: input.workingDir,
      timeout: ALGORITHM_TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: algorithmTestEnv(),
    })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-4000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error: Error) => {
      resolve({ exitCode: null, stderrTail: `${stderr}${error.message}` })
    })
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code,
        ...(signal ? { timedOut: true } : {}),
        stdoutTail: stdout,
        stderrTail: stderr,
      })
    })
  })
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

/** 读上游 `package.json` 并做版本闸（合法 SemVer）。 */
async function readUpstreamVersion(packageDir: string): Promise<string> {
  const text = await readTextIfExists(join(packageDir, 'package.json'))
  if (text === undefined) throw new Error('版本闸失败：上游包缺少 package.json')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('版本闸失败：上游 package.json 不是合法 JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('版本闸失败：上游 package.json 不是对象')
  }
  const version = (raw as Record<string, unknown>).version
  if (typeof version !== 'string' || version.trim() !== version || version.length > 40) {
    throw new Error('版本闸失败：上游 package.json 缺少合法 version')
  }
  if (!validSemver(version)) {
    throw new Error(`版本闸失败：上游版本号不是合法 SemVer（${version}）`)
  }
  return version
}

/**
 * 形状闸：用与覆盖层完全相同的 jiti 配置加载 staging 四件，校验导出并集。
 *
 * 用并集而不是单文件，是因为胶层消费的导出分散在四件里（plan 的 estimateTokens /
 * resolveEngine、select 的 selectNewestChunk、cooldown 的 inCooldownWindow、
 * recall 的 RecallStore / recallHint / recallResult）。
 */
async function assertAlgorithmExports(
  packageDir: string,
  loadModule: (entryPath: string) => Promise<unknown>,
): Promise<void> {
  const merged: Record<string, unknown> = {}
  for (const name of LIVE_COMPACT_ALGORITHM_MODULES) {
    const sourcePath = join(packageDir, 'extensions', `${name}.ts`)
    let loaded: unknown
    try {
      loaded = await loadModule(sourcePath)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`形状闸失败：上游 ${name}.ts 无法加载（${reason}）`)
    }
    if (typeof loaded !== 'object' || loaded === null) {
      throw new Error(`形状闸失败：上游 ${name}.ts 没有导出对象`)
    }
    for (const [key, value] of Object.entries(loaded)) {
      if (!Object.hasOwn(merged, key)) merged[key] = value
    }
  }
  const validation = validateAlgorithmShape(merged)
  if ('missing' in validation) {
    throw new Error(`形状闸失败：上游算法缺少胶层必需的导出：${validation.missing.join(', ')}`)
  }
}

/**
 * 行为闸：在 staging 目录里跑上游四份算法测试，要求退出码 0。
 *
 * Bun 不可用视为**闸失败而不是跳过**：没有测试闸的覆盖层等于把未验证的算法直接
 * 装进用户的上下文改写回路，宁可不同步。
 */
async function assertAlgorithmBehavior(
  packageDir: string,
  detectBun: () => Promise<LiveCompactBunRuntime>,
  runAlgorithmTests: (input: LiveCompactTestRunInput) => Promise<LiveCompactTestRunResult>,
): Promise<void> {
  let bun: LiveCompactBunRuntime
  try {
    bun = await detectBun()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`行为闸失败：Bun 运行时探测异常（${reason}）`)
  }
  if (!bun.available || !bun.path) {
    throw new Error('行为闸失败：未检测到可用的 Bun 运行时，无法执行上游算法测试（不跳过该闸）')
  }
  const result = await runAlgorithmTests({
    bunPath: bun.path,
    workingDir: packageDir,
    testFiles: LIVE_COMPACT_ALGORITHM_TESTS,
  })
  if (result.exitCode === 0) return

  const reason = result.timedOut
    ? `测试进程被终止（超时 ${ALGORITHM_TEST_TIMEOUT_MS}ms）`
    : `退出码 ${String(result.exitCode)}`
  const tail = `${result.stderrTail ?? ''}${result.stdoutTail ?? ''}`.trim().slice(-600)
  throw new Error(`行为闸失败：上游算法测试未通过（${reason}）${tail ? `：${tail}` : ''}`)
}

/**
 * 组装激活目录并原子发布。
 *
 * 先在 `versions/` 下建隐藏临时目录写全内容，再整体 rename 成正式目录名：
 * 任何中途失败都不会留下「名字对但内容不全」的版本目录，`active.json` 也只在
 * rename 成功后才写。
 */
async function activateVersion(options: {
  packageDir: string
  paths: LiveCompactSyncPaths
  version: string
  sha: string
  syncedAt: string
  warn: (message: string) => void
}): Promise<LiveCompactActiveManifest> {
  const { packageDir, paths, version, sha, syncedAt, warn } = options
  await mkdir(paths.versionsDir, { recursive: true })
  const buildDir = await mkdtemp(join(paths.versionsDir, '.build-'))
  const targetDir = join(paths.versionsDir, `${version}-${sha.slice(0, 7)}`)

  try {
    const sourceDir = join(buildDir, 'src')
    await mkdir(sourceDir, { recursive: true })
    for (const name of LIVE_COMPACT_ALGORITHM_MODULES) {
      await copyFile(join(packageDir, 'extensions', `${name}.ts`), join(sourceDir, `${name}.ts`))
    }
    await copyFile(join(packageDir, 'package.json'), join(buildDir, 'package.json'))
    await copyFile(join(packageDir, 'PORTING.md'), join(buildDir, 'PORTING.md'))
    await writeFile(join(sourceDir, 'index.ts'), OVERRIDE_INDEX_SOURCE, 'utf8')
    writeJsonFileAtomic(join(buildDir, 'UPSTREAM.json'), {
      repo: `https://github.com/${UPSTREAM_REPO}`,
      sha,
      version,
      syncedAt,
    })

    await rm(targetDir, { recursive: true, force: true })
    await rename(buildDir, targetDir)
  } catch (error) {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  const manifest: LiveCompactActiveManifest = { version, sha, syncedAt, path: targetDir }
  writeJsonFileAtomic(paths.activeManifestPath, manifest)
  // 清理旧版本失败不应反过来把一次成功的激活报成失败。
  await pruneVersions(paths.versionsDir, targetDir).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`[Live Compact] 旧版本清理失败（不影响本次激活）：${reason}`)
  })
  return manifest
}

/**
 * 版本目录清理：只保留最近 `MAX_RETAINED_VERSIONS` 个（当前 + 上一版）。
 *
 * 按 mtime 排序而不是按版本号：sha 可以回退重同步，版本号并不单调。
 */
export async function pruneVersions(versionsDir: string, activePath: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(versionsDir)
  } catch {
    return []
  }
  const directories: Array<{ path: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const fullPath = join(versionsDir, entry)
    try {
      const info = await stat(fullPath)
      if (!info.isDirectory()) continue
      directories.push({ path: fullPath, mtimeMs: info.mtimeMs })
    } catch {
      continue
    }
  }
  directories.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const keep = new Set<string>([activePath])
  for (const directory of directories) {
    if (keep.size >= MAX_RETAINED_VERSIONS) break
    keep.add(directory.path)
  }
  const removed: string[] = []
  for (const directory of directories) {
    if (keep.has(directory.path)) continue
    await rm(directory.path, { recursive: true, force: true }).catch(() => undefined)
    removed.push(directory.path)
  }
  return removed
}

/**
 * 创建同步服务。
 *
 * 服务是有状态的（进行中的同步 Promise + `syncing` 标记），因此同一进程内应当只
 * 创建一个实例（P3b 在 main 里做模块级单例）。
 */
export function createLiveCompactSyncService(options: LiveCompactSyncOptions): LiveCompactSyncService {
  const deps = options.deps ?? {}
  const paths = resolveLiveCompactSyncPaths(options.configDir)
  const fetcher = deps.fetcher
  const downloadTarball = deps.downloadTarball
    ?? ((sha: string, destinationPath: string) =>
      downloadUpstreamTarball(sha, destinationPath, fetcher ? { fetcher } : {}))
  const extractBundle = deps.extractBundle ?? extractUpstreamBundle
  const loadModule = deps.loadModule ?? loadLiveCompactSourceModule
  const detectBun = deps.detectBun ?? defaultDetectBun
  const runAlgorithmTests = deps.runAlgorithmTests ?? defaultRunAlgorithmTests
  const now = deps.now ?? (() => new Date())
  const warn = deps.warn ?? ((message: string) => console.warn(message))

  let inFlight: Promise<LiveCompactSyncResult> | undefined
  let syncing = false

  async function readActive(): Promise<LiveCompactActiveManifest | undefined> {
    const text = await readTextIfExists(paths.activeManifestPath)
    const manifest = parseActiveManifest(text)
    if (!manifest) return undefined
    // 目录被手删但清单还在时按「无覆盖层」处理，避免设置页展示一个加载不出来的版本。
    return (await pathIsDirectory(manifest.path)) ? manifest : undefined
  }

  async function readPersisted(): Promise<LiveCompactPersistedState> {
    return parsePersistedState(await readTextIfExists(paths.statePath))
  }

  async function buildState(
    persisted: LiveCompactPersistedState,
    isSyncing: boolean = syncing,
  ): Promise<LiveCompactState> {
    const active = await readActive()
    const bundledSha = getBundledSha()
    return {
      bundledVersion: getBundledVersion(),
      ...(bundledSha ? { bundledSha } : {}),
      ...(active ? { active } : {}),
      ...(persisted.lastCheck ? { upstream: persisted.lastCheck } : {}),
      syncing: isSyncing,
      ...(persisted.lastError ? { lastError: persisted.lastError } : {}),
    }
  }

  async function recordLastError(message: string): Promise<void> {
    const persisted = await readPersisted()
    await mkdir(paths.root, { recursive: true })
    writeJsonFileAtomic(paths.statePath, { ...persisted, lastError: message })
  }

  async function runSync(): Promise<LiveCompactSyncResult> {
    syncing = true
    let stagingDir: string | undefined
    try {
      await mkdir(paths.root, { recursive: true })

      // 1. 查 HEAD（拿 sha）——后续每一步都钉这个 sha。
      const head = await fetchUpstreamHead(fetcher)

      // 2. 下载 tarball 到 staging（失败时 downloadUpstreamTarball 自己清理半成品）。
      stagingDir = await mkdtemp(join(paths.root, 'staging-'))
      const tarballPath = join(stagingDir, 'upstream.tar.gz')
      await downloadTarball(head.sha, tarballPath)

      // 3. 白名单解包，保持上游原布局（extensions/ + tests/）。
      const packageDir = join(stagingDir, 'package')
      await extractBundle(tarballPath, packageDir)

      // 4. 闸 a：版本号。
      const version = await readUpstreamVersion(packageDir)

      // 5. 闸 b：导出形状。
      await assertAlgorithmExports(packageDir, loadModule)

      // 6. 闸 c：上游算法测试。
      await assertAlgorithmBehavior(packageDir, detectBun, runAlgorithmTests)

      // 7. 组装激活目录（extensions/ → src/ + index.ts + 元数据）并原子发布。
      const syncedAt = now().toISOString()
      await activateVersion({ packageDir, paths, version, sha: head.sha, syncedAt, warn })

      // 成功时清掉上一次的失败原因，并记下本次同步对应的上游检查结果。
      const lastCheck: LiveCompactCheckRecord = { sha: head.sha, date: head.date, checkedAt: syncedAt }
      writeJsonFileAtomic(paths.statePath, { lastCheck })
      return { ok: true, state: await buildState({ lastCheck }, false) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordLastError(message).catch(() => undefined)
      warn(`[Live Compact] 同步上游失败：${message}`)
      return { ok: false, error: message, state: await buildState(await readPersisted(), false) }
    } finally {
      // 无论成败都要复位运行标记：syncing 卡在 true 会让设置页永远显示“正在同步”。
      syncing = false
      if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    async getState(): Promise<LiveCompactState> {
      return await buildState(await readPersisted())
    },

    async checkUpstream(): Promise<LiveCompactCheckResult> {
      const head = await fetchUpstreamHead(fetcher)
      const checkedAt = now().toISOString()
      const active = await readActive()
      // 没有覆盖层时与随包基线 sha 比对，否则「刚装好就提示有更新」会误导用户。
      const baselineSha = active?.sha ?? getBundledSha()
      const updateAvailable = baselineSha !== undefined && head.sha !== baselineSha
      const persisted = await readPersisted()
      await mkdir(paths.root, { recursive: true })
      writeJsonFileAtomic(paths.statePath, {
        ...persisted,
        lastCheck: { sha: head.sha, date: head.date, checkedAt },
      })
      return { sha: head.sha, date: head.date, checkedAt, updateAvailable }
    },

    /**
     * 同步上游：进行中的重复调用共享同一个 Promise（设置页双击、按钮连点不会
     * 触发两次下载与两套闸）。
     */
    syncUpstream(): Promise<LiveCompactSyncResult> {
      if (inFlight) return inFlight
      inFlight = runSync().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },

    async resetToBundled(): Promise<LiveCompactState> {
      // 只删清单：版本目录保留，用户下次还能看到已下载的版本或手工回滚。
      await rm(paths.activeManifestPath, { force: true }).catch(() => undefined)
      const persisted = await readPersisted()
      return await buildState(persisted)
    },
  }
}
