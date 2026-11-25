/**
 * 存储管理服务
 *
 * 提供磁盘用量统计、临时文件清理、过期孤儿数据扫描/清理与归档会话数据清理。
 * 由设置面板「数据管理」Tab 和启动时自动清理逻辑调用。
 *
 * 孤儿清理的安全边界（硬约束）：
 * - 会话工作目录候选必须匹配 UUID 且不在索引全量会话 id 中；非 UUID 条目（memory/、
 *   skills/、workspace-files/ 等）一律不碰。
 * - 过期按 mtime 判定，目录取递归最大 mtime（最近活动时间）。
 * - Pi artifact 只在没有任何会话元数据引用时才视为孤儿。
 * - 清理执行时重新扫描，只删除与最近一次预览路径交集的部分，并在删除前重新校验。
 */

import { existsSync, statSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { rmSyncWithRetry } from './fs-retry'
import { join, basename, isAbsolute, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe } from './safe-file'
import type { AgentSessionMeta, AgentWorkspace } from '@proma/shared'
import type {
  CleanupResult,
  OrphanCategoryKey,
  OrphanCategoryPreview,
  OrphanEntry,
  OrphanScanResult,
} from '../../types'

// ─── 类型定义 ───

type StorageCategoryKey =
  | 'agent-sessions'
  | 'sdk-config'
  | 'workspaces'
  | 'temp-files'

interface StorageCategory {
  label: string
  key: StorageCategoryKey
  bytes: number
  count: number
}

interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
}

interface CleanupOptions {
  categories: StorageCategoryKey[]
  orphansOnly: boolean
  archivedBeforeDays: number
  /** 数据根覆盖（测试用）；生产省略即使用当前数据根。 */
  roots?: Partial<StorageRoots>
}

/**
 * Electron 的临时目录。
 *
 * 用惰性 require 而不是顶层 import：本模块的孤儿/归档清理是纯文件操作，
 * 单元测试不应被迫 mock electron 模块。
 */
function getElectronTempDir(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    return app.getPath('temp')
  } catch {
    return tmpdir()
  }
}

/** 存储根覆盖项：仅供测试注入临时目录。 */
export interface StorageRoots {
  configDir: string
}

/**
 * 孤儿扫描/清理的必填数据根。
 *
 * 故意设为必填而非默认值：破坏性清理一旦忘记传参就会落到真实 home，
 * 这类事故在类型层就应该被拦住。
 */
export type OrphanScanOptions = StorageRoots

// ─── 常量 ───

// 扫描时跳过的已知大型目录，防止超大工作区阻塞主进程事件循环
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.nuxt', '.git', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle',
  '.turbo', '.parcel-cache', '.svelte-kit', '.output',
])

// 单次扫描最大文件数上限，防止超大工作区导致无限递归
const MAX_FILE_SCAN = 100_000
const MAX_ORPHAN_ITEM_PREVIEW = 200

/** 会话工作目录必须是 UUID 命名的目录；这是防止误删工作区级元数据目录的结构性边界。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Live Compact 存档后缀：`<piSessionFile>.spine.jsonl`。 */
const SPINE_SIDECAR_SUFFIX = '.spine.jsonl'

/** Claude SDK 遗留目录：Pi runtime 不再使用，整目录可清理。 */
const LEGACY_SDK_ENTRIES = ['projects', 'file-history'] as const

const ORPHAN_CATEGORY_LABELS: Record<OrphanCategoryKey, string> = {
  'agent-sessions': '无索引引用的会话消息',
  'sdk-artifacts': '无引用的 Agent 运行数据（Pi artifact）',
  'spine-sidecars': '孤立的压缩存档（spine sidecar）',
  'session-attachments': '会话附件（引用关系未确认，默认跳过）',
  'orphan-workspaces': '过期会话工作目录',
  'legacy-sdk': '旧版 Claude SDK 遗留目录',
}

/** 不可自动删除的类别：审计不清，宁可跳过。 */
const NON_DELETABLE_ORPHAN_CATEGORIES = new Set<OrphanCategoryKey>(['session-attachments'])

// ─── 工具函数 ───

export function isUuidEntryName(name: string): boolean {
  return UUID_PATTERN.test(name)
}

/** 路径比较键：Windows 大小写不敏感。 */
function pathKey(targetPath: string): string {
  const normalized = resolve(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function resolveRoots(overrides?: Partial<StorageRoots>): StorageRoots {
  return { configDir: overrides?.configDir ?? getConfigDir() }
}

/** 存储根下的全部相关路径（纯拼接，不创建目录）。 */
function storagePaths(roots: StorageRoots) {
  const sdkDir = join(roots.configDir, 'sdk-config')
  return {
    configDir: roots.configDir,
    sessionsDir: join(roots.configDir, 'agent-sessions'),
    sessionsIndexPath: join(roots.configDir, 'agent-sessions.json'),
    workspacesDir: join(roots.configDir, 'agent-workspaces'),
    workspacesIndexPath: join(roots.configDir, 'agent-workspaces.json'),
    sdkDir,
    sdkSessionsDir: join(sdkDir, 'sessions'),
    sdkAttachmentsDir: join(sdkDir, 'session-attachments'),
  }
}

function readSessionIndex(roots: StorageRoots): AgentSessionMeta[] {
  const data = readJsonFileSafe<{ sessions?: AgentSessionMeta[] }>(storagePaths(roots).sessionsIndexPath)
  return Array.isArray(data?.sessions) ? data.sessions : []
}

function readWorkspaceIndex(roots: StorageRoots): AgentWorkspace[] {
  const data = readJsonFileSafe<{ workspaces?: AgentWorkspace[] }>(storagePaths(roots).workspacesIndexPath)
  return Array.isArray(data?.workspaces) ? data.workspaces : []
}

/**
 * Pi artifact 引用集。
 *
 * 引用源审计结果（截至本次改造）：
 * 1. `AgentSessionMeta.piSessionFile` —— 唯一直接指向 artifact 文件的字段；
 * 2. `AgentSessionMeta.piEntryBindings` —— 值是 Pi 树内部的 entry ID（UI UUID → entry ID），
 *    不指向文件，因此不贡献引用路径；
 * 3. 运行中会话的 artifact 已在 handleSessionId 时立即写入索引，且新 artifact 的 mtime
 *    必然晚于过期阈值，所以阈值本身构成第二道保护；
 * 4. `sdk-config/session-attachments/` 在现有代码中不存在（附件写在会话工作目录
 *    `attachments/` 下），该类目保持「只预览不删除」。
 */
function collectReferencedArtifacts(sessions: AgentSessionMeta[]): Set<string> {
  const references = new Set<string>()
  for (const session of sessions) {
    if (session.piSessionFile) references.add(pathKey(session.piSessionFile))
  }
  return references
}

function dayCutoff(days: number): number {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30
  return Date.now() - safeDays * 24 * 60 * 60 * 1000
}

async function getDirSize(
  dirPath: string,
  options: { skipTopLevelDirs?: Set<string> } = {}
): Promise<{ bytes: number; count: number }> {
  let bytes = 0
  let count = 0
  if (!existsSync(dirPath)) return { bytes, count }

  // limit 对象通过闭包在整个递归树内共享，作为全局文件计数上限
  const limit = { remaining: MAX_FILE_SCAN }

  async function walk(dir: string, depth: number): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (limit.remaining <= 0) return
        const fullPath = join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            if (depth === 0 && options.skipTopLevelDirs?.has(entry.name)) continue
            if (SKIP_DIRS.has(entry.name)) continue
            await walk(fullPath, depth + 1)
          } else if (entry.isFile()) {
            const stat = await fsPromises.stat(fullPath)
            bytes += stat.size
            count++
            limit.remaining--
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  await walk(dirPath, 0)
  return { bytes, count }
}

function safeUnlink(filePath: string): number {
  try {
    const size = statSync(filePath).size
    rmSyncWithRetry(filePath, { force: true })
    return size
  } catch {
    return 0
  }
}

/** 递归统计目录：字节数、文件数、递归最大 mtime（目录自身的最近活动时间）。 */
interface DirectorySummary {
  bytes: number
  fileCount: number
  lastModified: number
}

async function summarizeDirectory(dirPath: string): Promise<DirectorySummary> {
  let bytes = 0
  let fileCount = 0
  let lastModified = 0
  const limit = { remaining: MAX_FILE_SCAN }

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (limit.remaining <= 0) return
        const fullPath = join(dir, entry.name)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.mtimeMs > lastModified) lastModified = stat.mtimeMs
          if (stat.isDirectory()) {
            await walk(fullPath)
          } else if (stat.isFile()) {
            bytes += stat.size
            fileCount++
            limit.remaining--
          }
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  try {
    const rootStat = await fsPromises.lstat(dirPath)
    lastModified = rootStat.mtimeMs
  } catch {
    return { bytes, fileCount, lastModified }
  }
  await walk(dirPath)
  return { bytes, fileCount, lastModified }
}

// ─── 统计 ───

async function calcAgentSessionsCategory(roots: StorageRoots): Promise<StorageCategory> {
  const dir = storagePaths(roots).sessionsDir
  let bytes = 0, count = 0

  if (existsSync(dir)) {
    try {
      const files = await fsPromises.readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const fullPath = join(dir, file)
        try {
          const stat = await fsPromises.stat(fullPath)
          bytes += stat.size
          count++
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return { label: 'Agent 会话记录', key: 'agent-sessions', bytes, count }
}

async function calcSdkConfigCategory(roots: StorageRoots): Promise<StorageCategory> {
  const sdkDir = storagePaths(roots).sdkDir
  let bytes = 0, count = 0

  // sdk-config 其他子目录（sessions, backups 等）
  if (existsSync(sdkDir)) {
    try {
      const entries = await fsPromises.readdir(sdkDir)
      for (const entry of entries) {
        // Claude legacy artifacts are intentionally retained but no longer managed by Pi.
        if (entry === 'projects' || entry === 'file-history') continue
        const fullPath = join(sdkDir, entry)
        try {
          const stat = await fsPromises.lstat(fullPath)
          if (stat.isDirectory()) {
            const sub = await getDirSize(fullPath)
            bytes += sub.bytes
            count += sub.count
          } else {
            bytes += stat.size
            count++
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return { label: 'SDK 会话数据', key: 'sdk-config', bytes, count }
}

async function calcWorkspacesCategory(roots: StorageRoots): Promise<StorageCategory> {
  const wsDir = storagePaths(roots).workspacesDir
  let bytes = 0, count = 0

  if (existsSync(wsDir)) {
    try {
      const slugs = await fsPromises.readdir(wsDir)
      for (const slug of slugs) {
        const slugDir = join(wsDir, slug)
        try {
          if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
          const entries = await fsPromises.readdir(slugDir)
          for (const entry of entries) {
            const entryPath = join(slugDir, entry)
            try {
              const stat = await fsPromises.lstat(entryPath)
              if (!stat.isDirectory()) {
                if (stat.isFile()) {
                  bytes += stat.size
                  count++
                }
                continue
              }
              const sub = await getDirSize(entryPath)
              bytes += sub.bytes
              count += sub.count
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return { label: '项目与会话数据', key: 'workspaces', bytes, count }
}

async function calcTempFilesCategory(): Promise<StorageCategory> {
  const previewDir = join(tmpdir(), 'proma-preview')
  const installerDir = join(getElectronTempDir(), 'proma-installers')
  const [preview, installer] = await Promise.all([
    getDirSize(previewDir),
    getDirSize(installerDir),
  ])
  return {
    label: '临时预览/安装文件',
    key: 'temp-files',
    bytes: preview.bytes + installer.bytes,
    count: preview.count + installer.count,
  }
}

export async function calculateStorageStats(overrides?: Partial<StorageRoots>): Promise<StorageStats> {
  const roots = resolveRoots(overrides)
  const categories = await Promise.all([
    calcAgentSessionsCategory(roots),
    calcSdkConfigCategory(roots),
    calcWorkspacesCategory(roots),
    calcTempFilesCategory(),
  ])
  return {
    categories,
    totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
    calculatedAt: Date.now(),
  }
}

// ─── 临时文件清理 ───

export async function cleanupTempFiles(): Promise<CleanupResult> {
  let freedBytes = 0, deletedCount = 0
  const errors: string[] = []

  const previewDir = join(tmpdir(), 'proma-preview')
  if (existsSync(previewDir)) {
    try {
      const files = await fsPromises.readdir(previewDir)
      for (const file of files) {
        const freed = safeUnlink(join(previewDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理预览文件失败: ${e}`)
    }
  }

  const installerDir = join(getElectronTempDir(), 'proma-installers')
  if (existsSync(installerDir)) {
    try {
      const files = await fsPromises.readdir(installerDir)
      for (const file of files) {
        const freed = safeUnlink(join(installerDir, file))
        if (freed > 0) { freedBytes += freed; deletedCount++ }
      }
    } catch (e) {
      errors.push(`清理安装文件失败: ${e}`)
    }
  }

  if (freedBytes > 0) {
    console.log(`[存储清理] 临时文件: 释放 ${(freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${deletedCount} 个文件`)
  }
  return { freedBytes, deletedCount, errors }
}

// ─── 孤儿数据扫描 ───

interface OrphanScanContext {
  roots: StorageRoots
  cutoff: number
  sessionIds: Set<string>
  referencedArtifacts: Set<string>
}

interface OrphanScanCollection {
  context: OrphanScanContext
  entries: Map<OrphanCategoryKey, OrphanEntry[]>
}

function createOrphanScanContext(days: number, roots: StorageRoots): OrphanScanContext {
  const sessions = readSessionIndex(roots)
  return {
    roots,
    cutoff: dayCutoff(days),
    sessionIds: new Set(sessions.map((session) => session.id)),
    referencedArtifacts: collectReferencedArtifacts(sessions),
  }
}

/** 扫描无索引引用的会话消息文件（必须 UUID 命名，避免误删备份等非会话文件）。 */
async function scanOrphanSessionMessages(context: OrphanScanContext): Promise<OrphanEntry[]> {
  const dir = storagePaths(context.roots).sessionsDir
  const entries: OrphanEntry[] = []
  if (!existsSync(dir)) return entries

  for (const file of await fsPromises.readdir(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const id = basename(file, '.jsonl')
    if (!isUuidEntryName(id)) continue
    if (context.sessionIds.has(id)) continue
    const fullPath = join(dir, file)
    try {
      const stat = await fsPromises.stat(fullPath)
      if (stat.mtimeMs >= context.cutoff) continue
      entries.push({ path: fullPath, sizeBytes: stat.size, lastModified: stat.mtimeMs })
    } catch { /* skip */ }
  }
  return entries
}

/** 扫描无引用的 Pi artifact（`sdk-config/sessions/*.jsonl`，不含 spine sidecar）。 */
async function scanOrphanSdkArtifacts(context: OrphanScanContext): Promise<OrphanEntry[]> {
  const dir = storagePaths(context.roots).sdkSessionsDir
  const entries: OrphanEntry[] = []
  if (!existsSync(dir)) return entries

  for (const file of await fsPromises.readdir(dir)) {
    if (!file.endsWith('.jsonl') || file.endsWith(SPINE_SIDECAR_SUFFIX)) continue
    const fullPath = join(dir, file)
    if (context.referencedArtifacts.has(pathKey(fullPath))) continue
    try {
      const stat = await fsPromises.stat(fullPath)
      if (stat.mtimeMs >= context.cutoff) continue
      entries.push({ path: fullPath, sizeBytes: stat.size, lastModified: stat.mtimeMs })
    } catch { /* skip */ }
  }
  return entries
}

/**
 * 扫描孤立的 Live Compact sidecar：基础 artifact 已不存在，或基础 artifact 本身是孤儿，
 * 且 sidecar 自身也已过期。
 */
async function scanOrphanSpineSidecars(
  context: OrphanScanContext,
  orphanArtifactPaths: Set<string>,
): Promise<OrphanEntry[]> {
  const dir = storagePaths(context.roots).sdkSessionsDir
  const entries: OrphanEntry[] = []
  if (!existsSync(dir)) return entries

  for (const file of await fsPromises.readdir(dir)) {
    if (!file.endsWith(SPINE_SIDECAR_SUFFIX)) continue
    const fullPath = join(dir, file)
    const basePath = fullPath.slice(0, -SPINE_SIDECAR_SUFFIX.length)
    const baseAlive = existsSync(basePath)
    if (baseAlive) {
      // 基础 artifact 仍存在：只有它本身被判为孤儿时才清理它的存档。
      if (!orphanArtifactPaths.has(pathKey(basePath))) continue
    }
    try {
      const stat = await fsPromises.stat(fullPath)
      if (stat.mtimeMs >= context.cutoff) continue
      entries.push({ path: fullPath, sizeBytes: stat.size, lastModified: stat.mtimeMs })
    } catch { /* skip */ }
  }
  return entries
}

/**
 * 会话附件目录：现有代码里不存在该目录（附件写在会话工作目录下），
 * 若历史上出现也保持只预览不删除，因为无法确认哪个会话仍引用单个附件。
 */
async function scanSessionAttachments(context: OrphanScanContext): Promise<OrphanEntry[]> {
  const dir = storagePaths(context.roots).sdkAttachmentsDir
  const entries: OrphanEntry[] = []
  if (!existsSync(dir)) return entries

  for (const name of await fsPromises.readdir(dir)) {
    const fullPath = join(dir, name)
    try {
      const stat = await fsPromises.lstat(fullPath)
      if (stat.isDirectory()) {
        const summary = await summarizeDirectory(fullPath)
        if (summary.lastModified >= context.cutoff) continue
        entries.push({ path: fullPath, sizeBytes: summary.bytes, lastModified: summary.lastModified })
      } else {
        if (stat.mtimeMs >= context.cutoff) continue
        entries.push({ path: fullPath, sizeBytes: stat.size, lastModified: stat.mtimeMs })
      }
    } catch { /* skip */ }
  }
  return entries
}

/**
 * 扫描过期的会话工作目录。
 *
 * 只认 UUID 命名的目录，且必须不在会话索引中；因此 memory/、skills/、workspace-files/、
 * .context 等工作区级元目录结构性地不会被当作候选。
 */
async function scanOrphanWorkspaces(context: OrphanScanContext): Promise<OrphanEntry[]> {
  const wsDir = storagePaths(context.roots).workspacesDir
  const entries: OrphanEntry[] = []
  if (!existsSync(wsDir)) return entries

  for (const slug of await fsPromises.readdir(wsDir)) {
    const slugDir = join(wsDir, slug)
    try {
      if (!(await fsPromises.lstat(slugDir)).isDirectory()) continue
    } catch {
      continue
    }

    let names: string[]
    try {
      names = await fsPromises.readdir(slugDir)
    } catch {
      continue
    }

    for (const name of names) {
      if (!isUuidEntryName(name)) continue
      if (context.sessionIds.has(name)) continue
      const entryPath = join(slugDir, name)
      try {
        const stat = await fsPromises.lstat(entryPath)
        // 只处理真实目录：符号链接可能指向用户数据，不碰。
        if (!stat.isDirectory()) continue
        const summary = await summarizeDirectory(entryPath)
        if (summary.lastModified >= context.cutoff) continue
        entries.push({ path: entryPath, sizeBytes: summary.bytes, lastModified: summary.lastModified })
      } catch { /* skip */ }
    }
  }
  return entries
}

/** 扫描 Claude SDK 遗留目录（projects/、file-history/），整目录按递归 mtime 判定。 */
async function scanLegacySdkDirs(context: OrphanScanContext): Promise<OrphanEntry[]> {
  const sdkDir = storagePaths(context.roots).sdkDir
  const entries: OrphanEntry[] = []
  if (!existsSync(sdkDir)) return entries

  for (const name of LEGACY_SDK_ENTRIES) {
    const fullPath = join(sdkDir, name)
    if (!existsSync(fullPath)) continue
    try {
      if (!(await fsPromises.lstat(fullPath)).isDirectory()) continue
      const summary = await summarizeDirectory(fullPath)
      if (summary.lastModified >= context.cutoff) continue
      entries.push({ path: fullPath, sizeBytes: summary.bytes, lastModified: summary.lastModified })
    } catch { /* skip */ }
  }
  return entries
}

async function collectOrphanEntries(
  days: number,
  roots: StorageRoots,
): Promise<OrphanScanCollection> {
  const context = createOrphanScanContext(days, roots)
  const sdkArtifacts = await scanOrphanSdkArtifacts(context)
  const orphanArtifactPaths = new Set(sdkArtifacts.map((entry) => pathKey(entry.path)))

  const entries = new Map<OrphanCategoryKey, OrphanEntry[]>()
  entries.set('agent-sessions', await scanOrphanSessionMessages(context))
  entries.set('sdk-artifacts', sdkArtifacts)
  entries.set('spine-sidecars', await scanOrphanSpineSidecars(context, orphanArtifactPaths))
  entries.set('session-attachments', await scanSessionAttachments(context))
  entries.set('orphan-workspaces', await scanOrphanWorkspaces(context))
  entries.set('legacy-sdk', await scanLegacySdkDirs(context))

  return { context, entries }
}

/** 最近一次扫描的完整路径集合，用于「清理只删预览过的路径」。 */
let lastScanPreview: { days: number; paths: Map<OrphanCategoryKey, Set<string>> } | null = null

function toPreview(
  key: OrphanCategoryKey,
  entries: OrphanEntry[],
): OrphanCategoryPreview {
  return {
    key,
    label: ORPHAN_CATEGORY_LABELS[key],
    count: entries.length,
    sizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries: entries.slice(0, MAX_ORPHAN_ITEM_PREVIEW),
    totalEntries: entries.length,
  }
}

/** 扫描过期孤儿数据（只读预览，不删除任何内容）。 */
export async function scanOrphanData(
  days: number,
  options: OrphanScanOptions,
): Promise<OrphanScanResult> {
  const roots = resolveRoots(options)
  const collection = await collectOrphanEntries(days, roots)
  const order: OrphanCategoryKey[] = [
    'agent-sessions',
    'sdk-artifacts',
    'spine-sidecars',
    'session-attachments',
    'orphan-workspaces',
    'legacy-sdk',
  ]

  const paths = new Map<OrphanCategoryKey, Set<string>>()
  for (const key of order) {
    paths.set(key, new Set((collection.entries.get(key) ?? []).map((entry) => pathKey(entry.path))))
  }
  lastScanPreview = { days, paths }

  const categories = order.map((key) => toPreview(key, collection.entries.get(key) ?? []))
  return {
    days,
    categories,
    totalCount: categories.reduce((sum, category) => sum + category.count, 0),
    totalSizeBytes: categories.reduce((sum, category) => sum + category.sizeBytes, 0),
    scannedAt: Date.now(),
  }
}

// ─── 孤儿数据清理 ───

/**
 * 判断单个候选在删除前是否仍然是孤儿。
 *
 * 扫描与确认之间用户可能恢复了会话、重新打开了 artifact，索引或引用集都可能变化，
 * 所以每个条目都必须重新读一次当前状态。
 */
async function isStillOrphan(
  key: OrphanCategoryKey,
  entryPath: string,
  roots: StorageRoots,
): Promise<boolean> {
  const sessions = readSessionIndex(roots)
  const sessionIds = new Set(sessions.map((session) => session.id))
  const paths = storagePaths(roots)

  switch (key) {
    case 'agent-sessions': {
      const id = basename(entryPath, '.jsonl')
      return isUuidEntryName(id) && !sessionIds.has(id)
    }
    case 'sdk-artifacts': {
      if (!existsSync(entryPath)) return false
      return !collectReferencedArtifacts(sessions).has(pathKey(entryPath))
    }
    case 'spine-sidecars': {
      if (!existsSync(entryPath)) return false
      const basePath = entryPath.slice(0, -SPINE_SIDECAR_SUFFIX.length)
      if (!existsSync(basePath)) return true
      return !collectReferencedArtifacts(sessions).has(pathKey(basePath))
    }
    case 'orphan-workspaces': {
      const name = basename(entryPath)
      if (!isUuidEntryName(name)) return false
      if (sessionIds.has(name)) return false
      const slugDir = resolve(entryPath, '..')
      const wsDir = resolve(paths.workspacesDir)
      // 防御性校验：候选必须仍位于 <configDir>/agent-workspaces/<slug>/<uuid>
      const rel = relative(wsDir, slugDir)
      return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
    }
    case 'legacy-sdk': {
      return LEGACY_SDK_ENTRIES.some((name) => resolve(paths.sdkDir, name) === resolve(entryPath))
    }
    case 'session-attachments':
      return false
  }
}

/**
 * 清理过期孤儿数据。
 *
 * 规则：重新扫描 → 只取与最近一次 scanOrphanData 预览路径的交集 → 逐条重新校验 → 删除。
 * 没有预览记录时拒绝执行，避免「未确认即删除」。
 */
export async function cleanupOrphanData(
  days: number,
  options: OrphanScanOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = { freedBytes: 0, deletedCount: 0, errors: [] }
  const roots = resolveRoots(options)

  const preview = lastScanPreview
  if (!preview) {
    result.errors.push('请先扫描孤儿数据并确认预览结果，再执行清理')
    return result
  }

  const collection = await collectOrphanEntries(days, roots)
  const order: OrphanCategoryKey[] = [
    'agent-sessions',
    'sdk-artifacts',
    'spine-sidecars',
    'session-attachments',
    'orphan-workspaces',
    'legacy-sdk',
  ]

  for (const key of order) {
    const candidates = collection.entries.get(key) ?? []
    if (candidates.length === 0) continue

    const previewedPaths = preview.paths.get(key)
    const skippedByCategory = NON_DELETABLE_ORPHAN_CATEGORIES.has(key)
    if (skippedByCategory) {
      result.errors.push(
        `${ORPHAN_CATEGORY_LABELS[key]}：引用关系无法确认，已跳过 ${candidates.length} 项（未删除）`,
      )
      continue
    }

    // 扫描与确认之间的状态变化：预览里有、重扫后已不再是孤儿的条目一律不删，
    // 并在结果里留痕，避免用户以为全部清理成功。
    if (previewedPaths) {
      const rescanKeys = new Set(candidates.map((entry) => pathKey(entry.path)))
      const dropped = [...previewedPaths].filter((key) => !rescanKeys.has(key)).length
      if (dropped > 0) {
        result.errors.push(
          `${ORPHAN_CATEGORY_LABELS[key]}：重新校验后跳过 ${dropped} 项（已产生新引用或不再满足过期条件，未删除）`,
        )
      }
    }

    for (const entry of candidates) {
      const candidateKey = pathKey(entry.path)
      if (!previewedPaths || !previewedPaths.has(candidateKey)) continue
      if (!(await isStillOrphan(key, entry.path, roots))) {
        result.errors.push(
          `重新校验后跳过 ${entry.path}：已产生新的引用或索引条目，未删除`,
        )
        continue
      }

      try {
        if (key === 'agent-sessions' || key === 'sdk-artifacts' || key === 'spine-sidecars') {
          const freed = safeUnlink(entry.path)
          if (freed > 0) {
            result.freedBytes += freed
            result.deletedCount++
          }
          continue
        }

        // 目录类目：整目录删除（预览 + 过期 + 删除前重校验是安全网）
        const summary = await summarizeDirectory(entry.path)
        rmSyncWithRetry(entry.path, { recursive: true, force: true })
        result.freedBytes += summary.bytes
        result.deletedCount++
      } catch (error) {
        result.errors.push(
          `删除失败 ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // 预览是一次性确认凭证：清理后必须失效，避免重复点击误删新产生的孤儿。
  lastScanPreview = null

  if (result.freedBytes > 0) {
    console.log(
      `[存储清理] 孤儿数据: 释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${result.deletedCount} 项`,
    )
  }
  return result
}

// ─── 归档会话清理 ───

/** 运行中 Agent 会话 id 集合；查询失败时返回空集合（只影响「跳过运行中」这一层保护）。 */
async function getRunningSessionIds(): Promise<Set<string>> {
  try {
    const { listActiveAgentSessionSnapshots } = await import('./agent-service')
    return new Set(listActiveAgentSessionSnapshots().map((snapshot) => snapshot.sessionId))
  } catch (error) {
    console.warn('[存储清理] 读取运行中会话失败:', error)
    return new Set()
  }
}

export interface ArchivedCleanupOptions {
  /**
   * 数据根显式传入且必须完整：破坏性操作不接受「忘了传就用真实 home」的默认值。
   * 使用 StorageRoots（而非 Partial）让漏传 configDir 在类型检查阶段就失败。
   */
  roots: StorageRoots
  /** 测试注入：运行中会话 id */
  runningSessionIds?: Set<string>
}

/**
 * 清理超期归档会话的关联数据。
 *
 * 删除范围：Proma 消息 JSONL、Pi artifact（piSessionFile）及其 spine sidecar、
 * 会话工作目录。会话索引条目保留（用户仍能在列表中看到归档会话）。
 * 运行中的会话一律跳过；会话工作路径用只读拼接，避免 getter 的 mkdir 副作用。
 */
export async function cleanupArchivedSessions(
  beforeDays: number,
  options: ArchivedCleanupOptions,
): Promise<CleanupResult> {
  const result: CleanupResult = { freedBytes: 0, deletedCount: 0, errors: [] }
  if (!(beforeDays > 0)) return result

  const roots = options.roots
  const paths = storagePaths(roots)
  const cutoff = Date.now() - beforeDays * 24 * 60 * 60 * 1000
  const sessions = readSessionIndex(roots)
  const workspaces = readWorkspaceIndex(roots)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const runningSessionIds = options.runningSessionIds ?? await getRunningSessionIds()

  for (const session of sessions) {
    if (!session.archived) continue
    if (!(session.updatedAt < cutoff)) continue
    if (runningSessionIds.has(session.id)) continue

    const workspace = session.workspaceId ? workspaceById.get(session.workspaceId) : undefined

    // 1. Proma 消息 JSONL
    const messagesPath = join(paths.sessionsDir, `${session.id}.jsonl`)
    if (existsSync(messagesPath)) {
      const freed = safeUnlink(messagesPath)
      if (freed > 0) { result.freedBytes += freed; result.deletedCount++ }
    }

    // 2. Pi artifact + spine sidecar
    if (session.piSessionFile) {
      const artifactPath = session.piSessionFile
      const sidecarPath = `${artifactPath}${SPINE_SIDECAR_SUFFIX}`
      // 只清理数据根内的 artifact，避免索引脏值指向用户文件时误删。
      // Windows 跨盘符时 relative 返回绝对路径（不以 .. 开头），必须一并排除。
      const artifactRelativePath = relative(resolve(roots.configDir), resolve(artifactPath))
      const artifactInsideDataRoot = artifactRelativePath.length > 0
        && !artifactRelativePath.startsWith('..')
        && !isAbsolute(artifactRelativePath)
      if (artifactInsideDataRoot) {
        if (existsSync(sidecarPath)) {
          const freed = safeUnlink(sidecarPath)
          if (freed > 0) { result.freedBytes += freed; result.deletedCount++ }
        }
        if (existsSync(artifactPath)) {
          const freed = safeUnlink(artifactPath)
          if (freed > 0) { result.freedBytes += freed; result.deletedCount++ }
        }
      } else {
        result.errors.push(`跳过会话 ${session.id} 的 artifact：路径不在数据目录内`)
      }
    }

    // 3. 会话工作目录（只读拼接，不调用会 mkdir 的 getter）
    if (workspace) {
      const sessionDir = join(paths.workspacesDir, workspace.slug, session.id)
      if (existsSync(sessionDir)) {
        try {
          const summary = await summarizeDirectory(sessionDir)
          rmSyncWithRetry(sessionDir, { recursive: true, force: true })
          result.freedBytes += summary.bytes
          result.deletedCount++
        } catch (error) {
          result.errors.push(
            `删除会话工作目录失败 ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  if (result.freedBytes > 0) {
    console.log(
      `[存储清理] 归档数据: 释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB, 删除 ${result.deletedCount} 项`,
    )
  }
  return result
}

// ─── 汇总入口 ───

export async function cleanupStorage(options: CleanupOptions): Promise<CleanupResult> {
  if (options.orphansOnly) {
    // 旧入口已退役：孤儿数据必须经过「扫描 → 预览 → 确认」才能删除，
    // 这里不再接受无预览的静默删除请求。
    return {
      freedBytes: 0,
      deletedCount: 0,
      errors: ['孤儿数据清理需要先在「数据管理」中扫描并确认预览结果'],
    }
  }

  const roots = resolveRoots(options.roots)
  let totalFreed = 0, totalDeleted = 0
  const allErrors: string[] = []

  const merge = (r: CleanupResult) => {
    totalFreed += r.freedBytes
    totalDeleted += r.deletedCount
    allErrors.push(...r.errors)
  }

  for (const cat of options.categories) {
    if (cat === 'temp-files') {
      merge(await cleanupTempFiles())
      continue
    }

    if (options.archivedBeforeDays > 0) {
      if (cat === 'agent-sessions' || cat === 'sdk-config') {
        merge(await cleanupArchivedSessions(options.archivedBeforeDays, { roots }))
      }
    }
  }

  if (totalFreed > 0) {
    console.log(`[存储清理] 总计释放 ${(totalFreed / 1024 / 1024).toFixed(1)} MB, 删除 ${totalDeleted} 项`)
  }
  return { freedBytes: totalFreed, deletedCount: totalDeleted, errors: allErrors }
}
