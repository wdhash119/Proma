/**
 * 数据目录整体迁移服务
 *
 * 目标：允许用户把整个 Proma 数据根（~/.proma 或 ~/.proma-dev）搬到任意位置，
 * 避免系统盘空间不足。实现方式是「复制 → 校验 → 写指针 → 重启生效」：
 *
 * - 迁移只复制，不删除源数据；旧数据由用户显式点击「删除旧数据」才清理。
 * - 生效依赖 `<默认根>/data-root.json` 指针文件，由 config-paths 的 getConfigDir() 解析。
 * - 回滚 = 删除指针文件（下次启动回到默认根），因此要求默认根下旧数据仍在。
 * - 任何时刻只要有 Agent 会话在运行就拒绝迁移/删除/回滚，避免复制到一半的数据被写入。
 *
 * 所有公开函数都接受 `DataMigrationRootContext` 覆盖项，供单元测试注入临时目录、
 * 磁盘剩余空间与运行中会话数；生产调用不传，走真实的 getConfigDir()/orchestrator 查询。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import {
  DATA_ROOT_POINTER_FILENAME,
  getConfigDir,
  getDataRootPointerPath,
  getDefaultConfigDir,
  readDataRootPointer,
} from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { rmSyncWithRetry } from './fs-retry'
import type {
  DataMigrationPreflightResult,
  DataMigrationProgress,
  DataMigrationResult,
  DataRootInfo,
  DataRootRollbackResult,
  StorageCleanupResult,
} from '../../types'

/** 迁移的目标/来源根；测试可覆盖。 */
export interface DataMigrationRootContext {
  /** 当前生效的数据根 */
  currentRoot: string
  /** 默认数据根（不读指针） */
  defaultRoot: string
  /** 运行中 Agent 会话数；缺省时从 agent-service 查询 */
  runningSessions?: number
  /** 目标磁盘剩余字节；缺省时用 statfsSync 探测目标所在磁盘 */
  targetFreeBytes?: number
}

/** 迁移前必须为额外元数据/块对齐预留的空间比例。 */
const REQUIRED_FREE_SPACE_RATIO = 1.1

/** 进度回调签名。 */
export type DataMigrationProgressHandler = (progress: DataMigrationProgress) => void

/** 数据根下这些名字属于指针文件及其原子写残留，既不算「旧数据」，也不参与复制。 */
function isPointerArtifact(name: string): boolean {
  return name === DATA_ROOT_POINTER_FILENAME || name.startsWith(`${DATA_ROOT_POINTER_FILENAME}.`)
}

/** 迁移/统计时跳过数据根顶层的临时目录（内容可丢弃，复制没有意义）。 */
const SKIPPED_TOP_LEVEL_ENTRIES = new Set(['temp'])

/** 数据根目录树快照：相对路径 → 字节数。 */
interface DataRootTreeSnapshot {
  files: Map<string, number>
  totalFiles: number
  totalBytes: number
  /** 无法读取而被跳过的相对路径（复制同样跳过，保证快照与复制一致） */
  skipped: string[]
}

/** 判断 childPath 是否位于 parentPath 内部（不含相等）。 */
function isInside(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 判断路径是否为所在磁盘根（Windows 盘符根或 POSIX `/`）。 */
function isDriveRoot(targetPath: string): boolean {
  const normalized = resolve(targetPath)
  const root = parse(normalized).root
  if (!root) return false
  return normalized.length <= root.length || normalized === root.replace(/[\\/]+$/, '')
}

/** 目标目录下现有条目；目录不存在时返回空数组。 */
function readTargetEntries(targetPath: string): string[] {
  try {
    return readdirSync(targetPath)
  } catch {
    return []
  }
}

/** 探测目标路径所在磁盘剩余空间；目标尚未创建时回溯到最近的存在祖先。 */
function probeFreeBytes(targetPath: string): number {
  let probePath = resolve(targetPath)
  for (let depth = 0; depth < 64; depth++) {
    try {
      if (existsSync(probePath)) {
        const stats = statfsSync(probePath)
        return Number(stats.bavail) * Number(stats.bsize)
      }
    } catch {
      // 不可读或平台不支持 statfs：继续上溯
    }
    const parent = dirname(probePath)
    if (parent === probePath) break
    probePath = parent
  }
  return 0
}

/** 递归统计文件数/字节数，并可选地逐文件回调（用于复制进度）。 */
function walkDataRoot(
  root: string,
  onFile?: (relPath: string, sizeBytes: number, sourcePath: string) => void,
  onDir?: (relPath: string, sourcePath: string) => void,
): DataRootTreeSnapshot {
  const files = new Map<string, number>()
  const skipped: string[] = []
  const visitedDirs = new Set<string>()
  let totalBytes = 0

  if (!existsSync(root)) return { files, totalFiles: 0, totalBytes: 0, skipped }

  const walk = (dirPath: string, relPrefix: string, depth: number): void => {
    let realDir: string
    try {
      realDir = realpathSync(dirPath)
    } catch {
      skipped.push(relPrefix)
      return
    }
    // 跟随符号链接时可能形成环，用真实路径去重。
    if (visitedDirs.has(realDir)) return
    visitedDirs.add(realDir)

    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      skipped.push(relPrefix)
      return
    }

    for (const entry of entries) {
      const relPath = relPrefix ? join(relPrefix, entry.name) : entry.name
      if (depth === 0) {
        if (isPointerArtifact(entry.name)) continue
        if (SKIPPED_TOP_LEVEL_ENTRIES.has(entry.name)) continue
      }
      const entryPath = join(dirPath, entry.name)
      // stat 跟随符号链接：迁移语义是「复制内容」，与复制后的校验口径一致。
      let stat
      try {
        stat = statSync(entryPath)
      } catch {
        skipped.push(relPath)
        continue
      }
      if (stat.isDirectory()) {
        onDir?.(relPath, entryPath)
        walk(entryPath, relPath, depth + 1)
      } else if (stat.isFile()) {
        files.set(relPath, stat.size)
        totalBytes += stat.size
        onFile?.(relPath, stat.size, entryPath)
      }
    }
  }

  walk(root, '', 0)
  return { files, totalFiles: files.size, totalBytes, skipped }
}

/** 复制整个数据根；跳过规则与 walkDataRoot 完全一致。 */
function copyDataRoot(
  sourceRoot: string,
  targetRoot: string,
  onProgress?: DataMigrationProgressHandler,
  total?: { files: number; bytes: number },
): { copiedFiles: number; copiedBytes: number } {
  let copiedFiles = 0
  let copiedBytes = 0

  walkDataRoot(
    sourceRoot,
    (_relPath, sizeBytes, sourcePath) => {
      const relPath = relative(sourceRoot, sourcePath)
      const destPath = join(targetRoot, relPath)
      mkdirSync(dirname(destPath), { recursive: true })
      copyFileSync(sourcePath, destPath)
      copiedFiles++
      copiedBytes += sizeBytes
      onProgress?.({
        phase: 'copy',
        copiedFiles,
        totalFiles: total?.files ?? 0,
        copiedBytes,
        totalBytes: total?.bytes ?? 0,
      })
    },
    (relPath) => {
      mkdirSync(join(targetRoot, relPath), { recursive: true })
    },
  )

  return { copiedFiles, copiedBytes }
}

/**
 * 把位于 sourceRoot 内部的绝对路径改写到 targetRoot。
 *
 * 纯函数：只有绝对路径且确实落在旧数据根内才替换；其它值（含相对路径、
 * 数据根外的用户目录、非字符串）原样返回，由调用方比较恒等性判断是否变化。
 */
export function rewritePathInsideRoot(
  value: unknown,
  sourceRoot: string,
  targetRoot: string,
): unknown {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return value
  const resolvedSource = resolve(sourceRoot)
  const resolvedValue = resolve(value)
  // 路径恰好等于旧数据根本身：属于根内路径，整体替换成新根。
  if (resolvedValue === resolvedSource) return resolve(targetRoot)
  if (!isInside(resolvedValue, resolvedSource)) return value
  return join(resolve(targetRoot), relative(resolvedSource, resolvedValue))
}

/** 改写上下文：累计发生变化的字段数，0 表示该配置文件无需回写。 */
interface PathRewriteCounter {
  changed: number
}

function rewriteStringField(
  holder: Record<string, unknown>,
  key: string,
  sourceRoot: string,
  targetRoot: string,
  counter: PathRewriteCounter,
): void {
  const current = holder[key]
  const next = rewritePathInsideRoot(current, sourceRoot, targetRoot)
  if (next !== current) {
    holder[key] = next
    counter.changed++
  }
}

function rewriteStringArrayField(
  holder: Record<string, unknown>,
  key: string,
  sourceRoot: string,
  targetRoot: string,
  counter: PathRewriteCounter,
): void {
  const current = holder[key]
  if (!Array.isArray(current)) return
  const next = current.map((item) => rewritePathInsideRoot(item, sourceRoot, targetRoot))
  if (next.some((item, index) => item !== current[index])) {
    holder[key] = next
    counter.changed++
  }
}

/** 改写对象型记录里的路径字段（如 activeWorktree / checkoutHistory 项）。 */
function rewriteRecordPathFields(
  holder: unknown,
  fields: readonly string[],
  sourceRoot: string,
  targetRoot: string,
  counter: PathRewriteCounter,
): void {
  if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return
  const record = holder as Record<string, unknown>
  for (const field of fields) {
    rewriteStringField(record, field, sourceRoot, targetRoot, counter)
  }
}

/** vault.json：Vault 根与收件箱记录的是绝对路径，不改写会让笔记跟着旧数据被删。 */
function rewriteVaultConfig(config: unknown, sourceRoot: string, targetRoot: string): number {
  if (!config || typeof config !== 'object') return 0
  const counter: PathRewriteCounter = { changed: 0 }
  rewriteRecordPathFields(config, ['rootPath', 'inboxPath'], sourceRoot, targetRoot, counter)
  return counter.changed
}

/**
 * agent-sessions.json：会话索引里的 piSessionFile 等字段是绝对路径。
 *
 * 不改写会导致迁移后索引指向旧根：删旧数据后会话无法续跑；更危险的是
 * 孤儿扫描在新根看到 artifact，而引用集仍是旧根路径，pathKey 永不匹配，
 * 新根下所有超期 artifact（含活跃会话的）都会被误判为孤儿。
 */
function rewriteSessionIndexConfig(config: unknown, sourceRoot: string, targetRoot: string): number {
  if (!config || typeof config !== 'object') return 0
  const sessions = (config as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return 0

  const counter: PathRewriteCounter = { changed: 0 }
  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const session = entry as Record<string, unknown>
    rewriteRecordPathFields(session, ['piSessionFile', 'forkSourceDir'], sourceRoot, targetRoot, counter)
    rewriteStringArrayField(session, 'attachedDirectories', sourceRoot, targetRoot, counter)
    rewriteStringArrayField(session, 'attachedFiles', sourceRoot, targetRoot, counter)
    rewriteRecordPathFields(session.activeWorktree, ['path', 'mainRepoRoot'], sourceRoot, targetRoot, counter)
    const history = session.checkoutHistory
    if (Array.isArray(history)) {
      for (const item of history) {
        rewriteRecordPathFields(item, ['path', 'mainRepoRoot'], sourceRoot, targetRoot, counter)
      }
    }
  }
  return counter.changed
}

/** agent-workspaces.json：projectRootPath 通常在数据根外，改写是 no-op 守卫。 */
function rewriteWorkspaceIndexConfig(config: unknown, sourceRoot: string, targetRoot: string): number {
  if (!config || typeof config !== 'object') return 0
  const workspaces = (config as { workspaces?: unknown }).workspaces
  if (!Array.isArray(workspaces)) return 0

  const counter: PathRewriteCounter = { changed: 0 }
  for (const entry of workspaces) {
    rewriteRecordPathFields(entry, ['projectRootPath'], sourceRoot, targetRoot, counter)
  }
  return counter.changed
}

/** 迁移后需要跟随数据根改写的配置文件。 */
const DATA_ROOT_PATH_REWRITE_TARGETS: readonly {
  name: string
  rewrite: (config: unknown, sourceRoot: string, targetRoot: string) => number
}[] = [
  { name: 'vault.json', rewrite: rewriteVaultConfig },
  { name: 'agent-sessions.json', rewrite: rewriteSessionIndexConfig },
  { name: 'agent-workspaces.json', rewrite: rewriteWorkspaceIndexConfig },
]

/** 改写所有记录数据根绝对路径的配置（仅处理指向旧数据根内部的路径）。 */
function rewriteDataRootReferencingConfigs(targetRoot: string, sourceRoot: string): void {
  for (const target of DATA_ROOT_PATH_REWRITE_TARGETS) {
    const configPath = join(targetRoot, target.name)
    const config = readJsonFileSafe<unknown>(configPath)
    if (!config || typeof config !== 'object') continue

    const changed = target.rewrite(config, sourceRoot, targetRoot)
    if (changed === 0) continue

    // 只改动命中的路径字段，其余字段原样保留；原子写避免截断。
    writeJsonFileAtomic(configPath, config)
    console.log(`[数据迁移] 已改写 ${target.name} 中 ${changed} 处跟随数据根的路径`)
  }
}

/** 校验复制结果的完整性：逐文件相对路径与字节数必须完全一致。 */
function verifyCopiedTree(
  sourceSnapshot: DataRootTreeSnapshot,
  targetRoot: string,
): { ok: boolean; error?: string } {
  const targetSnapshot = walkDataRoot(targetRoot)
  if (targetSnapshot.totalFiles !== sourceSnapshot.totalFiles) {
    return {
      ok: false,
      error: `复制校验失败：文件数不一致（源 ${sourceSnapshot.totalFiles}，目标 ${targetSnapshot.totalFiles}）`,
    }
  }

  for (const [relPath, sizeBytes] of sourceSnapshot.files) {
    const copiedSize = targetSnapshot.files.get(relPath)
    if (copiedSize === undefined) {
      return { ok: false, error: `复制校验失败：目标缺少 ${relPath}` }
    }
    if (copiedSize !== sizeBytes) {
      return {
        ok: false,
        error: `复制校验失败：${relPath} 大小不一致（源 ${sizeBytes}，目标 ${copiedSize}）`,
      }
    }
  }

  return { ok: true }
}

function resolveContext(overrides?: Partial<DataMigrationRootContext>): DataMigrationRootContext {
  return {
    currentRoot: overrides?.currentRoot ?? getConfigDir(),
    defaultRoot: overrides?.defaultRoot ?? getDefaultConfigDir(),
    runningSessions: overrides?.runningSessions,
    targetFreeBytes: overrides?.targetFreeBytes,
  }
}

/**
 * 运行中会话数。
 *
 * 查询失败时返回 NaN：迁移类操作必须 fail closed，不能把「查不到」当成「没有」。
 * 使用动态 import，避免把整个 orchestrator 依赖链拉进只需要纯文件操作的调用方与测试。
 */
async function countRunningSessions(context: DataMigrationRootContext): Promise<number> {
  if (context.runningSessions !== undefined) return context.runningSessions
  try {
    const { listActiveAgentSessionSnapshots } = await import('./agent-service')
    return listActiveAgentSessionSnapshots().length
  } catch (error) {
    console.error('[数据迁移] 读取运行中会话数失败:', error)
    return Number.NaN
  }
}

/** 运行中会话守卫：返回拒绝原因，null 表示可以继续。 */
function runningSessionReason(runningSessions: number): string | null {
  if (!Number.isFinite(runningSessions)) {
    return '无法确认是否有会话正在运行，为避免数据损坏已中止操作，请重启应用后重试'
  }
  if (runningSessions > 0) {
    return `有 ${runningSessions} 个会话正在运行，请先等待它们结束再操作`
  }
  return null
}

/** 旧数据（默认根下除指针文件外的内容）条目。 */
function listOldDataEntries(defaultRoot: string): string[] {
  return readTargetEntries(defaultRoot).filter((name) => !isPointerArtifact(name))
}

/**
 * 数据根的核心文件：settings.json 或 agent-sessions.json。
 *
 * 两者都不存在说明该目录不是可用的数据根（迁移未生效、根被清空或刚创建），
 * 此时删除旧数据会让用户既失去旧数据也拿不到可用新数据。
 */
function hasEssentialDataFiles(root: string): boolean {
  return existsSync(join(root, 'settings.json')) || existsSync(join(root, 'agent-sessions.json'))
}

/** 递归统计目录/文件大小；不存在或不可读时返回 0。 */
function pathSize(targetPath: string): number {
  try {
    const stat = statSync(targetPath)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let total = 0
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      const entryPath = join(targetPath, entry.name)
      let entryStat
      try {
        entryStat = statSync(entryPath)
      } catch {
        continue
      }
      if (entryStat.isDirectory()) total += pathSize(entryPath)
      else if (entryStat.isFile()) total += entryStat.size
    }
    return total
  } catch {
    return 0
  }
}

/** preflight 的纯校验部分：不触碰文件系统，便于穷举拒绝分支。 */
export interface MigrationTargetValidationInput {
  target: string
  currentRoot: string
  defaultRoot: string
  sourceSizeBytes: number
  sourceFileCount: number
  targetFreeBytes: number
  runningSessions: number
  /** 目标目录现有条目（目录不存在时为空数组） */
  targetEntries: string[]
}

export function validateMigrationTarget(input: MigrationTargetValidationInput): {
  ok: boolean
  reason?: string
} {
  const { target, currentRoot, defaultRoot, sourceSizeBytes, targetFreeBytes, runningSessions } = input

  if (typeof target !== 'string' || target.trim().length === 0) {
    return { ok: false, reason: '请选择目标目录' }
  }
  if (!isAbsolute(target)) {
    return { ok: false, reason: '目标目录必须是绝对路径' }
  }

  const resolvedTarget = resolve(target)
  const resolvedCurrent = resolve(currentRoot)
  const resolvedDefault = resolve(defaultRoot)

  if (resolvedTarget === resolvedCurrent) {
    return { ok: false, reason: '目标目录与当前数据目录相同' }
  }
  if (isInside(resolvedTarget, resolvedCurrent)) {
    return { ok: false, reason: '目标目录不能位于当前数据目录内部，否则会递归复制' }
  }
  if (isDriveRoot(resolvedTarget)) {
    return { ok: false, reason: '不能直接迁移到磁盘根目录，请选择其下的子目录' }
  }

  const isReturnToDefault = resolvedTarget === resolvedDefault && resolvedCurrent !== resolvedDefault
  const meaningfulEntries = input.targetEntries.filter((name) => !isPointerArtifact(name))
  if (meaningfulEntries.length > 0) {
    return { ok: false, reason: '目标目录非空，请选择空目录' }
  }
  if (!isReturnToDefault && input.targetEntries.length > 0) {
    // 只剩指针文件但当前并不在自定义位置：说明默认根仍在用，不能覆盖。
    return { ok: false, reason: '目标目录非空，请选择空目录' }
  }

  const runningReason = runningSessionReason(runningSessions)
  if (runningReason) return { ok: false, reason: runningReason }

  if (sourceSizeBytes > 0 && targetFreeBytes > 0) {
    const required = Math.ceil(sourceSizeBytes * REQUIRED_FREE_SPACE_RATIO)
    if (targetFreeBytes < required) {
      const requiredMb = (required / 1024 / 1024).toFixed(1)
      const freeMb = (targetFreeBytes / 1024 / 1024).toFixed(1)
      return { ok: false, reason: `目标磁盘剩余空间不足（需要约 ${requiredMb} MB，剩余 ${freeMb} MB）` }
    }
  }

  return { ok: true }
}

/** 读取当前数据根信息。 */
export async function getDataRootInfo(
  overrides?: Partial<DataMigrationRootContext>,
): Promise<DataRootInfo> {
  const context = resolveContext(overrides)
  const resolvedCurrent = resolve(context.currentRoot)
  const resolvedDefault = resolve(context.defaultRoot)
  const isCustom = resolvedCurrent !== resolvedDefault

  const pointer = isCustom ? readDataRootPointer(context.defaultRoot) : null
  const oldDataEntries = isCustom ? listOldDataEntries(context.defaultRoot) : []
  const oldDataPresent = oldDataEntries.length > 0

  let oldDataSizeBytes: number | undefined
  if (oldDataPresent) {
    oldDataSizeBytes = 0
    for (const name of oldDataEntries) {
      oldDataSizeBytes += pathSize(join(context.defaultRoot, name))
    }
  }

  const running = await countRunningSessions(context)

  return {
    currentRoot: context.currentRoot,
    defaultRoot: context.defaultRoot,
    isCustom,
    ...(pointer ? { migratedAt: pointer.migratedAt } : {}),
    oldDataPresent,
    ...(oldDataSizeBytes !== undefined ? { oldDataSizeBytes } : {}),
    runningSessions: Number.isFinite(running) ? running : 0,
  }
}

/** 迁移前检查：目标合法性、剩余空间、运行中会话。 */
export async function preflightDataMigration(
  target: string,
  overrides?: Partial<DataMigrationRootContext>,
): Promise<DataMigrationPreflightResult> {
  const context = resolveContext(overrides)
  const sourceSnapshot = walkDataRoot(context.currentRoot)
  const runningSessions = await countRunningSessions(context)
  const targetFreeBytes = context.targetFreeBytes ?? probeFreeBytes(target ?? '')
  const targetEntries = typeof target === 'string' && isAbsolute(target)
    ? readTargetEntries(resolve(target))
    : []

  const validation = validateMigrationTarget({
    target,
    currentRoot: context.currentRoot,
    defaultRoot: context.defaultRoot,
    sourceSizeBytes: sourceSnapshot.totalBytes,
    sourceFileCount: sourceSnapshot.totalFiles,
    targetFreeBytes,
    runningSessions,
    targetEntries,
  })

  return {
    ...validation,
    sourceSizeBytes: sourceSnapshot.totalBytes,
    sourceFileCount: sourceSnapshot.totalFiles,
    targetFreeBytes,
  }
}

/**
 * 执行数据根迁移。
 *
 * 1. 重跑 preflight（防止预览与执行之间状态变化）；
 * 2. 逐文件复制，跳过指针文件与顶层 temp/；
 * 3. 校验文件数与逐文件字节数；不通过则不写指针，保留目标现场；
 * 4. 原子写指针（迁回默认位置时改为删除指针）。
 */
export async function migrateDataRoot(
  target: string,
  onProgress?: DataMigrationProgressHandler,
  overrides?: Partial<DataMigrationRootContext>,
): Promise<DataMigrationResult> {
  const context = resolveContext(overrides)
  const preflight = await preflightDataMigration(target, overrides)
  if (!preflight.ok) {
    const error = preflight.reason ?? '迁移前检查未通过'
    onProgress?.({
      phase: 'error',
      copiedFiles: 0,
      totalFiles: preflight.sourceFileCount,
      copiedBytes: 0,
      totalBytes: preflight.sourceSizeBytes,
      message: error,
    })
    return { success: false, error, copiedFiles: 0, copiedBytes: 0 }
  }

  const resolvedTarget = resolve(target)
  const resolvedCurrent = resolve(context.currentRoot)
  const resolvedDefault = resolve(context.defaultRoot)
  const isReturnToDefault = resolvedTarget === resolvedDefault && resolvedCurrent !== resolvedDefault

  onProgress?.({
    phase: 'scan',
    copiedFiles: 0,
    totalFiles: preflight.sourceFileCount,
    copiedBytes: 0,
    totalBytes: preflight.sourceSizeBytes,
  })

  try {
    mkdirSync(resolvedTarget, { recursive: true })

    const copied = copyDataRoot(resolvedCurrent, resolvedTarget, onProgress, {
      files: preflight.sourceFileCount,
      bytes: preflight.sourceSizeBytes,
    })

    onProgress?.({
      phase: 'verify',
      copiedFiles: copied.copiedFiles,
      totalFiles: preflight.sourceFileCount,
      copiedBytes: copied.copiedBytes,
      totalBytes: preflight.sourceSizeBytes,
    })

    const sourceSnapshot = walkDataRoot(resolvedCurrent)
    const verdict = verifyCopiedTree(sourceSnapshot, resolvedTarget)
    if (!verdict.ok) {
      const error = verdict.error ?? '复制校验失败'
      onProgress?.({
        phase: 'error',
        copiedFiles: copied.copiedFiles,
        totalFiles: preflight.sourceFileCount,
        copiedBytes: copied.copiedBytes,
        totalBytes: preflight.sourceSizeBytes,
        message: error,
      })
      return { success: false, error, copiedFiles: copied.copiedFiles, copiedBytes: copied.copiedBytes }
    }

    // 复制件里记录旧数据根绝对路径的配置要跟着迁移改写，否则迁移后仍指向旧目录。
    rewriteDataRootReferencingConfigs(resolvedTarget, resolvedCurrent)

    const pointerPath = join(context.defaultRoot, DATA_ROOT_POINTER_FILENAME)
    if (isReturnToDefault) {
      // 迁回默认位置：默认根已恢复为真实数据根，指针必须移除，否则下次启动仍指向旧的自定义目录。
      if (existsSync(pointerPath)) unlinkSync(pointerPath)
    } else {
      mkdirSync(context.defaultRoot, { recursive: true })
      const pointer = {
        version: 1 as const,
        target: resolvedTarget,
        migratedAt: new Date().toISOString(),
      }
      writeJsonFileAtomic(pointerPath, pointer)
    }

    onProgress?.({
      phase: 'done',
      copiedFiles: copied.copiedFiles,
      totalFiles: preflight.sourceFileCount,
      copiedBytes: copied.copiedBytes,
      totalBytes: preflight.sourceSizeBytes,
    })

    return {
      success: true,
      copiedFiles: copied.copiedFiles,
      copiedBytes: copied.copiedBytes,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[数据迁移] 迁移失败:', error)
    onProgress?.({
      phase: 'error',
      copiedFiles: 0,
      totalFiles: preflight.sourceFileCount,
      copiedBytes: 0,
      totalBytes: preflight.sourceSizeBytes,
      message,
    })
    return { success: false, error: message, copiedFiles: 0, copiedBytes: 0 }
  }
}

/**
 * 删除默认数据根下的旧数据。
 *
 * 仅在已迁移（currentRoot 与 defaultRoot 不同）时允许；保留指针文件本身。
 */
export async function deleteOldData(
  overrides?: Partial<DataMigrationRootContext>,
): Promise<StorageCleanupResult> {
  const context = resolveContext(overrides)
  const result: StorageCleanupResult = { freedBytes: 0, deletedCount: 0, errors: [] }

  if (resolve(context.currentRoot) === resolve(context.defaultRoot)) {
    result.errors.push('当前数据目录就是默认位置，没有旧数据需要删除')
    return result
  }

  // 前置守卫：当前根缺少关键文件说明迁移未真正生效（或根被清空），
  // 此时删除旧数据会让用户既丢旧数据也没有可用新数据。
  if (!hasEssentialDataFiles(context.currentRoot)) {
    result.errors.push('当前数据目录缺少关键文件，为防止数据丢失已拒绝删除旧数据')
    return result
  }

  const runningReason = runningSessionReason(await countRunningSessions(context))
  if (runningReason) {
    result.errors.push(runningReason)
    return result
  }

  for (const name of listOldDataEntries(context.defaultRoot)) {
    const entryPath = join(context.defaultRoot, name)
    const size = pathSize(entryPath)
    try {
      rmSyncWithRetry(entryPath, { recursive: true, force: true })
      result.freedBytes += size
      result.deletedCount++
    } catch (error) {
      result.errors.push(`删除旧数据失败 ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (result.freedBytes > 0) {
    console.log(
      `[数据迁移] 删除旧数据: 释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${result.deletedCount} 项`,
    )
  }
  return result
}

/**
 * 回滚到默认数据根：删除指针文件，下次启动重新使用 defaultRoot。
 *
 * 要求默认根下仍有旧数据，否则回滚后等于空数据根。
 */
export async function rollbackDataRoot(
  overrides?: Partial<DataMigrationRootContext>,
): Promise<DataRootRollbackResult> {
  const context = resolveContext(overrides)

  if (resolve(context.currentRoot) === resolve(context.defaultRoot)) {
    return { success: false, error: '当前数据目录就是默认位置，无需回滚' }
  }
  if (listOldDataEntries(context.defaultRoot).length === 0) {
    return { success: false, error: '默认数据目录下没有旧数据，回滚后将丢失全部数据' }
  }

  const runningReason = runningSessionReason(await countRunningSessions(context))
  if (runningReason) {
    return { success: false, error: runningReason }
  }

  const pointerPath = join(context.defaultRoot, DATA_ROOT_POINTER_FILENAME)
  try {
    if (existsSync(pointerPath)) unlinkSync(pointerPath)
  } catch (error) {
    return {
      success: false,
      error: `删除数据目录指针失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  console.log('[数据迁移] 已删除数据目录指针，重启后回到默认位置')
  return { success: true }
}

/** 供 IPC 使用的指针路径（避免 ipc.ts 重复拼接）。 */
export function getDataRootPointerFilePath(): string {
  return getDataRootPointerPath()
}
