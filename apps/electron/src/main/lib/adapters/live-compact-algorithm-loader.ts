/**
 * Live Compact 算法加载器：bundled（随 App 发版）与同步覆盖层（jiti 从磁盘加载）双路。
 *
 * 为什么要两条路：
 * - bundled 基线 = monorepo 里 vendored 的 `@proma/live-compact`（esbuild 打包进
 *   agent-runtime.cjs），行为由随包的 94 例上游测试守护，回滚成本等于回退 App 版本。
 * - 覆盖层 = 设置页“同步上游”把新算法写进 `<configDir>/live-compact/versions/...` 后，
 *   `active.json` 指向该目录；算法四件是 TS 源码，必须用 jiti 现场编译执行。
 *
 * 覆盖层永远不是“信任即生效”：本文件只负责加载与形状闸（缺任何胶层消费的导出就拒绝
 * 覆盖层、回落 bundled 并告警）。版本合法性、测试闸与原子激活在 P3a 的同步服务里。
 *
 * 每次解析都新建 jiti 实例：vendored 算法在**模块加载时**读 process.env 求值模块级常量
 * （select.ts 的 CHUNK_MIN/MAX、POINTER_TOKENS、KEEP_ROUNDS、KEEP_ROUND_TOKENS），
 * 复用实例会把上一次进程的 env 常量带进新会话，等于阈值注入静默失效。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 胶层实际消费的算法导出清单。
 *
 * 用途：
 * 1. 编译期：下面 `LiveCompactAlgorithm` 用 `Pick` 逐个校验这些名字确实存在于
 *    `@proma/live-compact` 的声明里，写错名字直接 typecheck 失败；
 * 2. 运行期：覆盖层形状闸按这份清单校验 jiti 加载出来的模块；
 * 3. P3a 同步服务的“导出形状闸”复用同一份清单，避免闸口与消费面漂移。
 */
export const REQUIRED_ALGORITHM_EXPORTS = [
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
  'RecallStore',
] as const

export type LiveCompactAlgorithmExportName = (typeof REQUIRED_ALGORITHM_EXPORTS)[number]

/**
 * 胶层持有的算法表面（结构类型，不复制签名）。
 * `Pick` 的键来自 REQUIRED_ALGORITHM_EXPORTS，因此清单与类型强绑定。
 */
export type LiveCompactAlgorithm = Pick<
  typeof import('@proma/live-compact'),
  LiveCompactAlgorithmExportName
>

/** `active.json` 的形状：P3a 写它，本批只读。 */
export interface LiveCompactActiveManifest {
  version: string
  sha: string
  syncedAt: string
  /** 已激活版本目录的绝对路径（内含 src/ 四件与 Proma 的 index.ts 再导出）。 */
  path: string
}

export type LiveCompactAlgorithmSource = 'bundled' | 'override'

export interface ResolvedLiveCompactAlgorithm {
  algorithm: LiveCompactAlgorithm
  source: LiveCompactAlgorithmSource
  /** 覆盖层信息；bundled 时为 undefined（bundled 版本随 App 发版）。 */
  override?: LiveCompactActiveManifest
  /** 覆盖层被拒绝或读取异常时的原因，供日志与设置页展示。 */
  warning?: string
}

/**
 * 依赖注入面：测试注入 fake fs / fake jiti，生产走默认实现。
 * 全部可选，缺省即真实实现。
 */
export interface LiveCompactAlgorithmLoaderDeps {
  /** 读取 active.json 文本；返回 undefined 表示文件不存在。 */
  readManifestText?: (manifestPath: string) => Promise<string | undefined>
  /** 用 jiti 加载覆盖层入口；返回模块命名空间。 */
  loadOverrideModule?: (entryPath: string) => Promise<unknown>
  /** 加载 bundled 算法；返回模块命名空间。 */
  loadBundledModule?: () => Promise<unknown>
  /** 告警出口（默认 console.warn）。 */
  warn?: (message: string) => void
}

/** 覆盖层入口候选：P3a 激活目录里应带 Proma 的 `src/index.ts` 再导出。 */
const OVERRIDE_ENTRY_CANDIDATES = ['src/index.ts', 'index.ts'] as const

/** jiti 实例的最小表面（1.x 与 2.x 都满足）。 */
interface JitiInstance {
  import: (id: string) => Promise<unknown>
}

type JitiFactory = (id: string, options?: Record<string, unknown>) => JitiInstance

export function resolveLiveCompactManifestPath(configDir: string): string {
  return join(configDir, 'live-compact', 'active.json')
}

/**
 * 解析当前应使用的算法实现。
 *
 * 决策顺序：
 * 1. active.json 不存在/不可读/JSON 损坏/字段缺失 → bundled（告警只在“存在但坏了”时发出）；
 * 2. 覆盖层加载失败或导出形状缺项 → bundled + 告警；
 * 3. 否则使用覆盖层。
 */
export async function resolveLiveCompactAlgorithm(
  configDir: string,
  deps: LiveCompactAlgorithmLoaderDeps = {},
): Promise<ResolvedLiveCompactAlgorithm> {
  const readManifestText = deps.readManifestText ?? readManifestTextFromDisk
  const loadBundled = deps.loadBundledModule ?? loadBundledModule
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  const manifestPath = resolveLiveCompactManifestPath(configDir)

  let warning: string | undefined
  let manifestText: string | undefined
  try {
    manifestText = await readManifestText(manifestPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warning = `Live Compact 覆盖层清单不可读（${manifestPath}）：${reason}；回退内置算法`
    warn(warning)
  }
  if (manifestText !== undefined) {
    const parsed = parseManifest(manifestText)
    if ('error' in parsed) {
      warning = `Live Compact 覆盖层清单不可用（${manifestPath}）：${parsed.error}；回退内置算法`
      warn(warning)
    } else {
      const loaded = await loadOverride(parsed.manifest, deps, warn)
      if ('error' in loaded) {
        warning = loaded.error
      } else {
        return {
          algorithm: loaded.algorithm,
          source: 'override',
          override: parsed.manifest,
        }
      }
    }
  }

  const bundled = await loadBundled()
  const validation = validateAlgorithmShape(bundled)
  if ('missing' in validation) {
    // bundled 缺导出属于打包事故，直接抛错比静默降级更安全。
    throw new Error(
      `内置 @proma/live-compact 缺少必需导出：${validation.missing.join(', ')}`,
    )
  }
  return {
    algorithm: validation.algorithm,
    source: 'bundled',
    ...(warning ? { warning } : {}),
  }
}

async function loadOverride(
  manifest: LiveCompactActiveManifest,
  deps: LiveCompactAlgorithmLoaderDeps,
  warn: (message: string) => void,
): Promise<{ algorithm: LiveCompactAlgorithm } | { error: string }> {
  const loadOverrideModule = deps.loadOverrideModule ?? loadLiveCompactSourceModule
  const errors: string[] = []
  for (const candidate of OVERRIDE_ENTRY_CANDIDATES) {
    const entryPath = join(manifest.path, candidate)
    let loaded: unknown
    try {
      loaded = await loadOverrideModule(entryPath)
    } catch (error) {
      errors.push(`${entryPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const validation = validateAlgorithmShape(loaded)
    if ('missing' in validation) {
      const message = `Live Compact 覆盖层缺少必需导出：${validation.missing.join(', ')}（${entryPath}）；回退内置算法`
      warn(message)
      return { error: message }
    }
    return { algorithm: validation.algorithm }
  }
  const message = `Live Compact 覆盖层加载失败：${errors.join('；') || '没有可用入口'}；回退内置算法`
  warn(message)
  return { error: message }
}

function parseManifest(text: string): { manifest: LiveCompactActiveManifest } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: '清单不是一个对象' }
  }
  const record = raw as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const sha = typeof record.sha === 'string' ? record.sha.trim() : ''
  const syncedAt = typeof record.syncedAt === 'string' ? record.syncedAt.trim() : ''
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  const missing = [
    version ? '' : 'version',
    sha ? '' : 'sha',
    syncedAt ? '' : 'syncedAt',
    path ? '' : 'path',
  ].filter((name) => name.length > 0)
  if (missing.length > 0) {
    return { error: `清单缺少字段 ${missing.join('/')}` }
  }
  return { manifest: { version, sha, syncedAt, path } }
}

/**
 * 形状闸：逐项确认必需导出存在。
 * `RecallStore` 是类，另外确认原型上真的带 bind/put/get —— 只有函数导出但方法缺失的
 * 覆盖层会在第一次切段时炸掉 turn，必须在加载期拦住。
 */
export function validateAlgorithmShape(
  candidate: unknown,
): { algorithm: LiveCompactAlgorithm } | { missing: string[] } {
  if (typeof candidate !== 'object' || candidate === null) {
    return { missing: [...REQUIRED_ALGORITHM_EXPORTS] }
  }
  const record = candidate as Record<string, unknown>
  const missing: string[] = []
  for (const name of REQUIRED_ALGORITHM_EXPORTS) {
    const value = record[name]
    if (typeof value !== 'function') {
      missing.push(name)
      continue
    }
    if (name === 'RecallStore') {
      const prototype = (value as { prototype?: Record<string, unknown> }).prototype
      const requiredMethods = ['bind', 'put', 'get']
      const absent = requiredMethods.filter((method) => typeof prototype?.[method] !== 'function')
      if (absent.length > 0) missing.push(`${name}.${absent.join('/')}`)
    }
  }
  if (missing.length > 0) return { missing }
  return { algorithm: record as unknown as LiveCompactAlgorithm }
}

/** 默认实现：从磁盘读 active.json，不存在时返回 undefined，其它错误上抛给调用方降级。 */
async function readManifestTextFromDisk(manifestPath: string): Promise<string | undefined> {
  try {
    return await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** 默认实现：bundled 走 workspace 包（esbuild 打包时静态内联）。 */
async function loadBundledModule(): Promise<unknown> {
  return await import('@proma/live-compact')
}

/**
 * 默认实现：jiti 现场编译覆盖层 TS 源码。
 *
 * 版本兼容：jiti 2.x 导出 `createJiti`，1.x 的默认导出是同一个工厂（`createJITI`）。
 * 这里按最小结构取工厂，避免把某个具体版本的导出名钉进类型。
 * 参数不用 `import.meta.url`：agent-runtime 是 esbuild 的 CJS 产物，`import.meta` 不可用；
 * 入口路径本身是绝对路径，jiti 的解析基点对相对 `./plan.ts` 的解析没有影响。
 *
 * 导出给 P3a 同步服务的导出形状闸复用：staging 里的上游源码必须与覆盖层用同一套
 * jiti 配置编译，否则“闸里能加载、装上跑不了”这类偏差无从发现。
 */
export async function loadLiveCompactSourceModule(entryPath: string): Promise<unknown> {
  const module = (await import('jiti')) as unknown as {
    createJiti?: JitiFactory
    default?: JitiFactory
  }
  const createJiti = module.createJiti ?? module.default
  if (typeof createJiti !== 'function') {
    throw new TypeError('jiti 模块缺少 createJiti 工厂，无法加载 Live Compact 覆盖层')
  }
  const jiti = createJiti(process.cwd(), {
    // 覆盖层是 ESM 风格的 `.ts` 源码，需要 default 互操作。
    interopDefault: true,
    // 关键：不缓存编译结果与模块实例，保证模块级 env 常量按当前进程 env 重新求值。
    moduleCache: false,
    fsCache: false,
  })
  return await jiti.import(entryPath)
}
