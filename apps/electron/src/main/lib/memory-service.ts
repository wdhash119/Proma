/**
 * 记忆服务：全局画像 + 项目记忆的单条维护、检索与版本历史。
 *
 * 存储边界：
 * - 全局画像：`<configDir>/memory/user_profile.md`，跨工作区共享；
 * - 项目记忆：`<workspace>/memory/` 下的 `MEMORY.md`（纯路由索引）与 `memory/*.md`（按需主题）。
 *
 * 写入一律带 revision 校验，并在覆盖前把旧内容存成可恢复的历史快照；
 * 单条操作（add / update / remove）只改动命中的那一行 `- ` 事实，不再整篇重写。
 *
 * 归档与旧画像扫描同样在这里：归档是「移动到 `memory/.archive/`」而不是删除，
 * 旧画像扫描只读、只报告可迁移来源，不替调用方做任何写入决定。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { getConfigDir } from './config-paths'
import { getWorkspaceAutoMemoryDir } from './agent-workspace-manager'
import { writeTextFileAtomic } from './safe-file'

/** 记忆目标层级：全局画像、项目索引、项目主题文件。 */
export type MemoryTargetKind = 'global-profile' | 'project-index' | 'project-theme'

/** 全局画像文件名；与项目 `user-profile` 语义区分。 */
export const GLOBAL_PROFILE_TARGET = 'global-profile'
export const PROJECT_INDEX_TARGET = 'MEMORY.md'
const GLOBAL_MEMORY_DIR_NAME = 'memory'
const REVISIONS_DIR_NAME = '.revisions'
const MAX_REVISIONS_PER_TARGET = 50
const MAX_SEARCH_HITS = 40
/** 单个记忆文件的硬上限；超过它说明该按主题拆分，而不是继续堆正文。 */
export const MAX_MEMORY_FILE_BYTES = 512 * 1024
/** 归档目录名；与主题文件同层，但不参与主题枚举。 */
const ARCHIVE_DIR_NAME = '.archive'
/** 全局画像预算：常驻每轮上下文，必须可一眼扫完。 */
export const PROFILE_MAX_CHARS = 5000
export const PROFILE_MAX_FACTS = 100
/** 旧画像可能存在的相对目录与文件名，覆盖历史版本与 Claude 兼容布局。 */
const LEGACY_PROFILE_DIRS = ['memory', join('.claude', 'memory')] as const
const LEGACY_PROFILE_NAMES = ['user-profile.md', 'user_profile.md'] as const
/** 全局画像与项目索引的常驻预算，与项目 AGENTS.md 的约束保持一致。 */
const TARGET_BUDGET_CHARS: Record<string, number> = {
  'global-profile': 5000,
  'MEMORY.md': 3500,
}

export interface MemoryTargetInfo {
  target: string
  kind: MemoryTargetKind
  label: string
  /** 记忆正文的字符数（去空白后），用于预算判断。 */
  chars: number
  /** 内容哈希；写入时作为乐观锁。 */
  revision: string
  updatedAt?: number
  budgetChars?: number
}

export interface MemoryDocument {
  target: string
  kind: MemoryTargetKind
  content: string
  revision: string
  chars: number
  path: string
  budgetChars?: number
}

export interface MemoryRevisionSummary {
  id: string
  target: string
  createdAt: number
  summary: string
  chars: number
}

export interface MemorySearchHit {
  /** 展示用来源：`全局画像` 或 `项目记忆/MEMORY.md` 等。 */
  source: string
  target: string
  line: number
  text: string
  score: number
}

export interface MemoryEntryOperation {
  op: 'add' | 'update' | 'remove'
  /** add / update 的新条目，必须是以 `- ` 开头的单行事实。 */
  entry?: string
  /** update / remove 的匹配文本；按行匹配，必须唯一命中。 */
  match?: string
  /** add 时插入到指定条目之后。 */
  after?: string
}

export interface MemoryUpdateInput {
  target: string
  revision: string
  summary: string
  content?: string
  operations?: MemoryEntryOperation[]
}

export interface MemoryUpdateResult {
  target: string
  revision: string
  chars: number
  /** 本次写入产生的历史快照；未产生历史（内容未变）时为空。 */
  snapshotId?: string
}

/** 任意记忆文件的只读快照；用于旧画像、来源索引等不在标准目标枚举里的文件。 */
export interface MemoryFileSnapshot {
  path: string
  content: string
  revision: string
  chars: number
}

/** 一份旧画像来源；`id` 是路径哈希，跨调用保持稳定。 */
export interface LegacyProfileLocation extends MemoryFileSnapshot {
  id: string
}

/** 主题归档结果；归档后主题不再处于有效入口。 */
export interface MemoryArchiveResult {
  target: string
  /** 归档后的绝对路径；可用它把内容恢复回 `memory/`。 */
  archivedTo: string
  /** 写入 `MEMORY.md` 后的新 revision。 */
  indexRevision: string
  /** 本次归档在历史里的快照 ID（如果有）。 */
  snapshotId?: string
}

export class MemoryError extends Error {}

/** 全局画像超出 100 条事实或 5000 UTF-16 码元预算。 */
export class ProfileBudgetExceededError extends MemoryError {
  readonly attemptedChars: number
  readonly maxChars: number
  readonly attemptedFacts: number
  readonly maxFacts: number

  constructor(attemptedChars: number, attemptedFacts: number) {
    super(
      `全局画像超预算：${attemptedFacts} 条事实 / ${attemptedChars} 码元，上限 ${PROFILE_MAX_FACTS} 条 / ${PROFILE_MAX_CHARS} 码元。`,
    )
    this.name = 'ProfileBudgetExceededError'
    this.attemptedChars = attemptedChars
    this.maxChars = PROFILE_MAX_CHARS
    this.attemptedFacts = attemptedFacts
    this.maxFacts = PROFILE_MAX_FACTS
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function countChars(content: string): number {
  return content.replace(/\s/g, '').length
}

function slugifyTarget(target: string): string {
  return target === GLOBAL_PROFILE_TARGET
    ? 'global-profile'
    : basename(target).replace(/[^\w.-]+/g, '_')
}

/**
 * 测试注入的记忆根目录。生产环境始终走配置目录与工作区目录，
 * 避免测试把事实写进用户真实记忆。
 */
interface MemoryRootsOverride {
  globalMemoryDir: string
  projectMemoryDir: (workspaceSlug: string) => string
}

let rootsOverride: MemoryRootsOverride | undefined

/** 仅供测试：注入隔离的记忆根目录，传 undefined 恢复默认解析。 */
export function setMemoryRootsForTesting(override: MemoryRootsOverride | undefined): void {
  rootsOverride = override
}

function globalMemoryDir(): string {
  if (rootsOverride) {
    ensureDirectory(rootsOverride.globalMemoryDir)
    return rootsOverride.globalMemoryDir
  }
  const dir = join(getConfigDir(), GLOBAL_MEMORY_DIR_NAME)
  ensureDirectory(dir)
  return dir
}

function projectMemoryDir(workspaceSlug: string): string {
  if (rootsOverride) {
    const dir = rootsOverride.projectMemoryDir(workspaceSlug)
    ensureDirectory(dir)
    return dir
  }
  return getWorkspaceAutoMemoryDir(workspaceSlug)
}

function ensureDirectory(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function projectThemeTargets(workspaceSlug: string): string[] {
  const dir = projectMemoryDir(workspaceSlug)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => name !== PROJECT_INDEX_TARGET && name !== 'user-profile.md' && name !== 'project-preferences.md')
    .sort()
}

/** 全局画像文件路径；供测试与设置页定位实际文件。 */
export function getGlobalMemoryFilePath(): string {
  return join(globalMemoryDir(), 'user_profile.md')
}

/** 指定工作区的记忆目录；供测试与设置页定位实际文件。 */
export function getWorkspaceMemoryDirectory(workspaceSlug: string): string {
  return projectMemoryDir(workspaceSlug)
}

/** 列出可维护的记忆目标：全局画像 + 项目索引 + 项目主题文件。 */
export function listMemoryTargets(workspaceSlug?: string): MemoryTargetInfo[] {
  const targets: MemoryTargetInfo[] = []
  const globalPath = getGlobalMemoryFilePath()
  targets.push({
    target: GLOBAL_PROFILE_TARGET,
    kind: 'global-profile',
    label: '全局画像',
    ...readMeta(globalPath),
    budgetChars: TARGET_BUDGET_CHARS[GLOBAL_PROFILE_TARGET],
  })

  if (!workspaceSlug) return targets
  const projectDir = projectMemoryDir(workspaceSlug)
  targets.push({
    target: PROJECT_INDEX_TARGET,
    kind: 'project-index',
    label: '项目记忆索引',
    ...readMeta(join(projectDir, PROJECT_INDEX_TARGET)),
    budgetChars: TARGET_BUDGET_CHARS[PROJECT_INDEX_TARGET],
  })
  for (const name of projectThemeTargets(workspaceSlug)) {
    targets.push({
      target: name,
      kind: 'project-theme',
      label: `项目记忆/${name}`,
      ...readMeta(join(projectDir, name)),
    })
  }
  return targets
}

function readMeta(filePath: string): { chars: number; revision: string; updatedAt?: number } {
  if (!existsSync(filePath)) return { chars: 0, revision: hashContent('') }
  const content = readFileSync(filePath, 'utf8')
  return { chars: countChars(content), revision: hashContent(content) }
}

function resolveTargetPath(target: string, workspaceSlug?: string): { filePath: string; kind: MemoryTargetKind; label: string } {
  if (target === GLOBAL_PROFILE_TARGET) {
    return { filePath: getGlobalMemoryFilePath(), kind: 'global-profile', label: '全局画像' }
  }
  if (!workspaceSlug) {
    throw new MemoryError(`项目记忆需要工作区上下文：${target}`)
  }
  const projectDir = projectMemoryDir(workspaceSlug)
  if (target === PROJECT_INDEX_TARGET) {
    return { filePath: join(projectDir, PROJECT_INDEX_TARGET), kind: 'project-index', label: '项目记忆索引' }
  }
  // 只允许维护 memory/ 下的 Markdown 主题文件，拒绝路径穿越。
  if (!target.endsWith('.md') || target.includes('/') || target.includes('\\') || target.startsWith('.')) {
    throw new MemoryError(`非法的记忆目标：${target}`)
  }
  if (!projectThemeTargets(workspaceSlug).includes(target)) {
    // 主题文件允许首次创建：Agent 可先完善已有主题，必要时再新增一个。
    console.log(`[记忆] 将创建新的记忆主题：${target}`)
  }
  return { filePath: join(projectDir, target), kind: 'project-theme', label: `项目记忆/${target}` }
}

/** 读取单个记忆目标；目标不存在时返回空文档，便于首次创建。 */
export function readMemoryDocument(target: string, workspaceSlug?: string): MemoryDocument {
  const { filePath, kind } = resolveTargetPath(target, workspaceSlug)
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  return {
    target,
    kind,
    content,
    revision: hashContent(content),
    chars: countChars(content),
    path: filePath,
    budgetChars: TARGET_BUDGET_CHARS[target],
  }
}

// ===== 单条条目操作 =====

function splitLines(content: string): string[] {
  return content.split('\n')
}

function normalizeEntry(entry: string | undefined): string {
  const value = entry?.trim()
  if (!value) throw new MemoryError('entry 不能为空')
  if (!value.startsWith('- ')) throw new MemoryError('entry 必须是以 "- " 开头的单条事实')
  if (value.includes('\n')) throw new MemoryError('entry 必须是单行事实')
  return value
}

function findSingleMatchIndex(lines: string[], match: string, op: string): number {
  const needle = match.trim()
  if (!needle) throw new MemoryError(`${op} 需要 match`)
  const indexes = lines
    .map((line, index) => (line.trim() === needle ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length === 0) throw new MemoryError(`未找到匹配条目：${needle}`)
  if (indexes.length > 1) throw new MemoryError(`匹配到多条相同条目，请提供更完整的文本：${needle}`)
  return indexes[0]!
}

/**
 * 按单条事实修改正文。只触碰命中的行，未涉及的段落、标题与顺序保持原样。
 */
export function applyMemoryOperations(content: string, operations: MemoryEntryOperation[]): string {
  if (operations.length === 0) throw new MemoryError('operations 不能为空')
  let lines = splitLines(content)

  for (const operation of operations) {
    if (operation.op === 'add') {
      const entry = normalizeEntry(operation.entry)
      if (operation.after) {
        const anchor = findSingleMatchIndex(lines, operation.after, 'add')
        lines = [...lines.slice(0, anchor + 1), entry, ...lines.slice(anchor + 1)]
        continue
      }
      // 默认追加到末尾的非空事实之后，保留文末换行语义。
      let insertAt = lines.length
      while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt -= 1
      lines = [...lines.slice(0, insertAt), entry, ...lines.slice(insertAt)]
      continue
    }

    if (operation.op === 'update') {
      const entry = normalizeEntry(operation.entry)
      const index = findSingleMatchIndex(lines, operation.match ?? '', 'update')
      lines = [...lines.slice(0, index), entry, ...lines.slice(index + 1)]
      continue
    }

    const index = findSingleMatchIndex(lines, operation.match ?? '', 'remove')
    lines = [...lines.slice(0, index), ...lines.slice(index + 1)]
  }

  const next = lines.join('\n')
  return next.endsWith('\n') || next.length === 0 ? next : `${next}\n`
}

// ===== 版本历史 =====

function revisionsDir(filePath: string): string {
  const dir = join(dirname(filePath), REVISIONS_DIR_NAME)
  ensureDirectory(dir)
  return dir
}

function revisionPrefix(target: string): string {
  return `${slugifyTarget(target)}__`
}

function snapshotMemory(filePath: string, target: string, content: string, summary: string): string | undefined {
  if (!content.trim()) return undefined
  const dir = revisionsDir(filePath)
  const createdAt = Date.now()
  const id = `${revisionPrefix(target)}${createdAt}__${hashContent(content).slice(0, 8)}`
  const payload = { id, target, createdAt, summary, chars: countChars(content), content }
  writeTextFileAtomic(join(dir, `${id}.json`), JSON.stringify(payload, null, 2))
  pruneRevisions(dir, target)
  return id
}

function pruneRevisions(dir: string, target: string): void {
  const prefix = revisionPrefix(target)
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
  const overflow = files.length - MAX_REVISIONS_PER_TARGET
  if (overflow <= 0) return
  for (const name of files.slice(0, overflow)) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      // 历史清理失败不影响主写入。
    }
  }
}

function readSnapshot(filePath: string, target: string, id: string): { content: string; summary: string; createdAt: number } | null {
  const dir = revisionsDir(filePath)
  const fullPath = join(dir, `${id}.json`)
  if (!existsSync(fullPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as { content?: unknown; summary?: unknown; createdAt?: unknown }
    if (typeof parsed.content !== 'string') return null
    return {
      content: parsed.content,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    }
  } catch {
    return null
  }
}

/** 列出某个记忆目标的历史版本，最新在前。 */
export function listMemoryHistory(target: string, workspaceSlug?: string, limit = 20): MemoryRevisionSummary[] {
  const { filePath } = resolveTargetPath(target, workspaceSlug)
  const dir = revisionsDir(filePath)
  const prefix = revisionPrefix(target)
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, limit))

  const revisions: MemoryRevisionSummary[] = []
  for (const name of files) {
    const snapshot = readSnapshot(filePath, target, name.slice(0, -'.json'.length))
    if (!snapshot) continue
    revisions.push({
      id: name.slice(0, -'.json'.length),
      target,
      createdAt: snapshot.createdAt,
      summary: snapshot.summary,
      chars: countChars(snapshot.content),
    })
  }
  return revisions
}

/** 读取历史版本正文，供预览与恢复。 */
export function readMemoryRevision(target: string, id: string, workspaceSlug?: string): { id: string; content: string; summary: string; createdAt: number } | null {
  const { filePath } = resolveTargetPath(target, workspaceSlug)
  const snapshot = readSnapshot(filePath, target, id)
  return snapshot ? { id, ...snapshot } : null
}

/** 恢复到指定历史版本；当前内容会先存成新快照，恢复动作本身也可回退。 */
export function restoreMemoryRevision(target: string, id: string, workspaceSlug?: string): MemoryUpdateResult {
  const { filePath } = resolveTargetPath(target, workspaceSlug)
  const snapshot = readSnapshot(filePath, target, id)
  if (!snapshot) throw new MemoryError(`历史版本不存在：${id}`)
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const snapshotId = snapshotMemory(filePath, target, current, `恢复到 ${id} 之前的自动快照`)
  writeTextFileAtomic(filePath, snapshot.content)
  return {
    target,
    revision: hashContent(snapshot.content),
    chars: countChars(snapshot.content),
    ...(snapshotId ? { snapshotId } : {}),
  }
}

// ===== 写入 =====

/**
 * 写入记忆目标。`revision` 必须是最近一次读取得到的值，避免覆盖并发修改；
 * 传入 `operations` 时只改单条事实，传入 `content` 时整篇重写。
 */
export function updateMemory(input: MemoryUpdateInput, workspaceSlug?: string): MemoryUpdateResult {
  const { filePath } = resolveTargetPath(input.target, workspaceSlug)
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const currentRevision = hashContent(current)
  if (input.revision !== currentRevision) {
    throw new MemoryError(`记忆已被修改，请重新读取后再写入（当前 revision: ${currentRevision}）`)
  }
  if (!input.summary.trim()) throw new MemoryError('summary 不能为空')

  const next = input.content !== undefined
    ? input.content
    : input.operations?.length
      ? applyMemoryOperations(current, input.operations)
      : (() => { throw new MemoryError('需要提供 content 或 operations') })()

  if (next === current) {
    return { target: input.target, revision: currentRevision, chars: countChars(current) }
  }

  const snapshotId = snapshotMemory(filePath, input.target, current, input.summary)
  writeTextFileAtomic(filePath, next)
  return {
    target: input.target,
    revision: hashContent(next),
    chars: countChars(next),
    ...(snapshotId ? { snapshotId } : {}),
  }
}

// ===== 检索 =====

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；|/]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

/**
 * 跨全局画像与项目记忆检索。逐行打分，返回命中最多的行片段；
 * 不做模糊纠错，命中条件严格按子串包含，避免编造不存在的记忆。
 */
export function searchMemory(query: string, workspaceSlug?: string, limit = 20): MemorySearchHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const maxHits = Math.min(Math.max(1, limit), MAX_SEARCH_HITS)

  const documents: Array<{ target: string; source: string; content: string }> = []
  const globalPath = getGlobalMemoryFilePath()
  if (existsSync(globalPath)) {
    documents.push({ target: GLOBAL_PROFILE_TARGET, source: '全局画像', content: readFileSync(globalPath, 'utf8') })
  }
  if (workspaceSlug) {
    const projectDir = projectMemoryDir(workspaceSlug)
    for (const name of [PROJECT_INDEX_TARGET, ...projectThemeTargets(workspaceSlug)]) {
      const filePath = join(projectDir, name)
      if (!existsSync(filePath)) continue
      documents.push({ target: name, source: `项目记忆/${name}`, content: readFileSync(filePath, 'utf8') })
    }
  }

  const hits: MemorySearchHit[] = []
  for (const document of documents) {
    const lines = document.content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const lowered = line.toLowerCase()
      let score = 0
      for (const token of tokens) {
        if (lowered.includes(token)) score += token.length
      }
      if (score === 0) continue
      hits.push({ source: document.source, target: document.target, line: index + 1, text: line.trim(), score })
    }
  }

  return hits.sort((left, right) => right.score - left.score).slice(0, maxHits)
}

// ===== 底层文件访问（旧画像、来源索引、归档） =====

/** 工作区根目录（`<workspace>/memory/` 的父目录）；迁移日志等状态文件放在这一层。 */
export function getWorkspaceRootDirectory(workspaceSlug: string): string {
  return dirname(projectMemoryDir(workspaceSlug))
}

/**
 * 校验记忆文件本身是否可安全读写。
 *
 * - 符号链接一律拒绝：链接会让「归档」「迁移」这类移动动作作用到意料之外的文件；
 * - 非普通文件拒绝，避免往目录或设备文件里写正文；
 * - 超过 512 KiB 拒绝，提示先按主题拆分。
 */
function assertRegularMemoryFile(filePath: string): void {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(filePath)
  } catch {
    // 文件不存在是允许的：调用方可能正要创建它。
    return
  }
  if (stats.isSymbolicLink()) throw new MemoryError(`记忆符号链接不被接受：${filePath}`)
  if (!stats.isFile()) throw new MemoryError(`记忆目标不是普通文件：${filePath}`)
  if (stats.size > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryError(`记忆文件超过 512 KiB，请先按主题拆分：${filePath}`)
  }
}

/** 读取任意记忆文件；不存在时返回空正文与空正文的 revision。 */
export function readMemoryFileAt(filePath: string): MemoryFileSnapshot {
  assertRegularMemoryFile(filePath)
  if (!existsSync(filePath)) {
    return { path: filePath, content: '', revision: hashContent(''), chars: 0 }
  }
  const content = readFileSync(filePath, 'utf8')
  return { path: filePath, content, revision: hashContent(content), chars: countChars(content) }
}

/** 原子写入任意记忆文件；符号链接与非普通文件拒绝，目录自动创建。 */
export function writeMemoryFileText(filePath: string, content: string): void {
  if (!isAbsolute(filePath)) throw new MemoryError(`记忆文件必须是绝对路径：${filePath}`)
  assertRegularMemoryFile(filePath)
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryError(`记忆文件超过 512 KiB，请先按主题拆分：${filePath}`)
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeTextFileAtomic(filePath, content)
}

/** 统计正文里 `- ` 事实条目数，供全局画像预算校验。 */
export function countProfileFacts(content: string): number {
  return content.split('\n').filter((line) => /^\s*-\s+\S/.test(line)).length
}

/** 全局画像写入前的硬预算校验：≤100 条事实、≤5000 UTF-16 码元。 */
export function assertProfileBudget(content: string): void {
  const attemptedChars = content.length
  const attemptedFacts = countProfileFacts(content)
  if (attemptedFacts > PROFILE_MAX_FACTS || attemptedChars > PROFILE_MAX_CHARS) {
    throw new ProfileBudgetExceededError(attemptedChars, attemptedFacts)
  }
}

// ===== 主题归档 =====

/** 归档时间戳目录名：稳定排序、无平台分隔符冲突。 */
function archiveTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** 在归档根下创建唯一的时间戳目录；同毫秒连续归档时追加序号。 */
function createArchiveDirectory(archiveRoot: string, now: number): string {
  const base = join(archiveRoot, archiveTimestamp(now))
  let candidate = base
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    try {
      mkdirSync(candidate, { recursive: false })
      return candidate
    } catch (error) {
      // 只对「同名目录已存在」重试；权限等问题应当立即暴露。
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      candidate = `${base}-${attempt}`
    }
  }
  throw new MemoryError(`无法创建归档目录：${archiveRoot}`)
}

/**
 * 归档一个项目记忆主题。
 *
 * 归档是**移动**：主题正文原封不动挪到 `<workspace>/memory/.archive/<timestamp>/<name>`，
 * 随后用 `indexContent` 覆盖 `MEMORY.md`（走既有 revision 校验与历史快照），
 * 这样索引里不再保留失效入口，但内容始终可以搬回来。
 *
 * 全局画像与 `MEMORY.md` 是常驻核心，不能用归档处理，只能逐条改写。
 */
export function archiveMemoryTheme(
  workspaceSlug: string,
  target: string,
  revision: string,
  indexRevision: string,
  indexContent: string,
): MemoryArchiveResult {
  if (target === GLOBAL_PROFILE_TARGET) throw new MemoryError('全局画像是常驻核心记忆，不能归档；请用 MemoryUpdate 逐条改写。')
  if (target === PROJECT_INDEX_TARGET) throw new MemoryError('项目记忆索引是常驻核心记忆，不能归档；请用 MemoryUpdate 逐条改写。')
  if (!target.endsWith('.md') || target.includes('/') || target.includes('\\') || target.startsWith('.')) {
    throw new MemoryError(`非法的记忆目标：${target}`)
  }
  if (!indexContent.trim()) throw new MemoryError('归档必须同时提供移除该主题入口后的 MEMORY.md 正文。')
  if (indexContent.toLowerCase().includes(basename(target).toLowerCase())) {
    throw new MemoryError(`归档后的 MEMORY.md 仍保留 ${target} 的入口；请先移除该路由，其他主题入口保持不变。`)
  }

  const projectDir = projectMemoryDir(workspaceSlug)
  const themePath = join(projectDir, target)
  const indexFilePath = join(projectDir, PROJECT_INDEX_TARGET)

  // 先做完所有校验，避免「已经动了一个文件才发现另一个不允许写」。
  const theme = readMemoryFileAt(themePath)
  if (!theme.content.trim()) throw new MemoryError(`记忆主题不存在或为空，无法归档：${target}`)
  if (theme.revision !== revision) {
    throw new MemoryError(`记忆已被修改，请重新读取后再归档（当前 revision: ${theme.revision}）`)
  }
  const index = readMemoryFileAt(indexFilePath)
  if (index.revision !== indexRevision) {
    throw new MemoryError(`项目记忆索引已被修改，请重新读取后再归档（当前 revision: ${index.revision}）`)
  }

  const archiveRoot = join(projectDir, ARCHIVE_DIR_NAME)
  mkdirSync(archiveRoot, { recursive: true })
  const archivedTo = join(createArchiveDirectory(archiveRoot, Date.now()), target)

  renameSync(themePath, archivedTo)
  let update: MemoryUpdateResult
  try {
    update = updateMemory({
      target: PROJECT_INDEX_TARGET,
      revision: indexRevision,
      summary: `归档 ${target} 后同步移除索引入口`,
      content: indexContent,
    }, workspaceSlug)
  } catch (error) {
    // 索引写不进去就把主题搬回原位，保持「要么都成，要么都没动」。
    try {
      renameSync(archivedTo, themePath)
      rmdirSync(dirname(archivedTo))
    } catch {
      // 回滚失败时保留归档副本：内容仍在 `.archive` 下，可人工恢复。
    }
    throw error
  }

  return {
    target,
    archivedTo,
    indexRevision: update.revision,
    ...(update.snapshotId ? { snapshotId: update.snapshotId } : {}),
  }
}

// ===== 旧画像来源扫描 =====

function legacyProfileCandidates(workspaceSlug: string): string[] {
  const workspaceRoot = getWorkspaceRootDirectory(workspaceSlug)
  const candidates: string[] = []
  for (const directory of LEGACY_PROFILE_DIRS) {
    for (const name of LEGACY_PROFILE_NAMES) {
      candidates.push(resolve(workspaceRoot, directory, name))
    }
  }
  return candidates
}

/**
 * 扫描当前工作区里的旧画像文件。
 *
 * 只读、只列举：每个来源带 `id`（路径 sha256）、正文与 revision，
 * 供 `MemoryMigrateProfile` 在合并前做 revision 校验。
 * 符号链接、非普通文件与超过 512 KiB 的文件直接报错，不静默跳过——
 * 「读不到」不能被当作「不存在」覆盖。
 */
export function readLegacyProfileLocations(workspaceSlug: string): LegacyProfileLocation[] {
  const seen = new Map<string, string>()
  const locations: LegacyProfileLocation[] = []

  for (const candidate of legacyProfileCandidates(workspaceSlug)) {
    if (!existsSync(candidate)) continue
    const snapshot = readMemoryFileAt(candidate)
    if (!snapshot.content.trim()) continue
    let identity: string
    try {
      identity = realpathSync.native(candidate)
    } catch {
      identity = candidate
    }
    const alias = seen.get(identity)
    if (alias) {
      throw new MemoryError(`多个旧画像入口指向同一文件，当前提案无法同步其余来源索引：${alias}、${candidate}`)
    }
    seen.set(identity, candidate)
    locations.push({ id: hashContent(candidate), ...snapshot })
  }

  return locations.sort((left, right) => left.path.localeCompare(right.path))
}

/** 按 `id` 取一份旧画像来源；不存在时返回 undefined。 */
export function findLegacyProfileLocation(workspaceSlug: string, id: string): LegacyProfileLocation | undefined {
  return readLegacyProfileLocations(workspaceSlug).find((location) => location.id === id)
}
