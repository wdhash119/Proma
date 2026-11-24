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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getConfigDir } from './config-paths'
import { getWorkspaceAutoMemoryDir, listAgentWorkspaces } from './agent-workspace-manager'
import { writeTextFileAtomic } from './safe-file'
import {
  applyMemoryOperations,
  assertMemoryContentEntries,
  MAX_MEMORY_ENTRY_CHARS,
  MemoryError,
  type MemoryEntryOperation,
} from './memory-entry-metadata'

export { applyMemoryOperations, MAX_MEMORY_ENTRY_CHARS, MemoryError }
export type { MemoryEntryOperation }

/** 记忆目标层级：全局画像、项目索引、项目主题文件。 */
type MemoryTargetKind = 'global-profile' | 'project-index' | 'project-theme'

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
/** 归档 journal 目录名；崩溃后续跑用，独立于归档正文目录。 */
const ARCHIVE_JOURNAL_DIR_NAME = '.archive-journal'
/** 历史快照 ID 的文件名模式：`<target 前缀><毫秒时间戳>__<8 位内容哈希>`。 */
const REVISION_ID_SUFFIX_PATTERN = /^\d+__[0-9a-f]{8}$/
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

interface MemoryTargetInfo {
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

interface MemoryDocument {
  target: string
  kind: MemoryTargetKind
  content: string
  revision: string
  chars: number
  path: string
  budgetChars?: number
}

interface MemoryRevisionSummary {
  id: string
  target: string
  createdAt: number
  summary: string
  chars: number
}

interface MemorySearchHit {
  /** 展示用来源：`全局画像` 或 `项目记忆/MEMORY.md` 等。 */
  source: string
  target: string
  line: number
  text: string
  score: number
}

interface MemoryUpdateInput {
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
interface LegacyProfileLocation extends MemoryFileSnapshot {
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
    .filter((name) => name !== PROJECT_INDEX_TARGET && name !== 'user-profile.md' && name !== 'user_profile.md' && name !== 'project-preferences.md')
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
  const filePath = join(projectDir, target)
  return { filePath, kind: 'project-theme', label: `项目记忆/${target}` }
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

// ===== 版本历史 =====

function revisionsDir(filePath: string): string {
  const dir = join(dirname(filePath), REVISIONS_DIR_NAME)
  ensureDirectory(dir)
  return dir
}

function revisionPrefix(target: string): string {
  return `${slugifyTarget(target)}__`
}

/**
 * 校验历史快照 ID 是否属于指定目标。
 *
 * ID 会参与文件名拼接，因此必须限制为目标前缀 + 时间戳 + 哈希，
 * 并显式拒绝路径分隔符，避免 `../` 之类的穿越读取。
 */
export function isValidMemoryRevisionId(target: string, id: string): boolean {
  if (!id || id.length > 200) return false
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false
  const prefix = revisionPrefix(target)
  if (!id.startsWith(prefix)) return false
  return REVISION_ID_SUFFIX_PATTERN.test(id.slice(prefix.length))
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
  if (!isValidMemoryRevisionId(target, id)) return null
  const dir = revisionsDir(filePath)
  const fullPath = resolve(dir, `${id}.json`)
  // 双保险：即使文件名校验被绕过，解析后的绝对路径也必须仍位于快照目录内。
  if (dirname(fullPath) !== resolve(dir)) return null
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(fullPath)
  } catch {
    return null
  }
  // 快照必须是普通文件；符号链接可能把读取引向任意 JSON。
  if (stats.isSymbolicLink() || !stats.isFile()) return null
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as {
      id?: unknown
      target?: unknown
      content?: unknown
      summary?: unknown
      createdAt?: unknown
    }
    if (typeof parsed.content !== 'string') return null
    // 快照必须与请求的目标、ID 一致，避免跨目标恢复或伪造文件名。
    if (parsed.id !== id || parsed.target !== target) return null
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

/**
 * 恢复到指定历史版本。
 *
 * `expectedCurrentRevision` 必须是调用方刚读到的当前正文 revision：
 * 恢复前若 Agent 或另一个窗口又写了新内容，这里直接拒绝，避免静默覆盖。
 * 当前内容会先存成新快照，恢复动作本身也可回退。
 */
export function restoreMemoryRevision(
  target: string,
  id: string,
  expectedCurrentRevision: string,
  workspaceSlug?: string,
): MemoryUpdateResult {
  const { filePath } = resolveTargetPath(target, workspaceSlug)
  if (!isValidMemoryRevisionId(target, id)) throw new MemoryError(`非法的历史版本 ID：${id}`)
  assertRegularMemoryFile(filePath)
  const snapshot = readSnapshot(filePath, target, id)
  if (!snapshot) throw new MemoryError(`历史版本不存在：${id}`)
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const currentRevision = hashContent(current)
  if (expectedCurrentRevision !== currentRevision) {
    throw new MemoryError(`记忆已被修改，请刷新后再恢复（当前 revision: ${currentRevision}）`)
  }
  // 恢复只保留既有预算与体积契约：历史快照里可能存在今天才禁止的长条目，
  // 不能因为新增的单条长度/重复校验让旧版本无法恢复；新规则只管新写入。
  assertWritableMemoryContent(target, snapshot.content)
  const snapshotId = snapshotMemory(filePath, target, current, `恢复到 ${id} 之前的自动快照`)
  writeMemoryFileText(filePath, snapshot.content)
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
  // 旧项目画像仍可被 MemoryInspect 与迁移扫描读取，但不能再作为活跃主题续写。
  if (LEGACY_PROFILE_NAMES.some((name) => name === input.target)) {
    throw new MemoryError(`项目旧画像 ${input.target} 只作为迁移输入，不接受 MemoryUpdate 写入；请使用 collaboration.md 或先完成迁移`)
  }
  const { filePath } = resolveTargetPath(input.target, workspaceSlug)
  assertRegularMemoryFile(filePath)
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const currentRevision = hashContent(current)
  if (input.revision !== currentRevision) {
    throw new MemoryError(`记忆已被修改，请重新读取后再写入（当前 revision: ${currentRevision}）`)
  }
  if (!input.summary.trim()) throw new MemoryError('summary 不能为空')
  if (input.content !== undefined && input.operations !== undefined) {
    throw new MemoryError('content 与 operations 只能二选一，不能同时传入；请分两次调用以明确写入顺序')
  }

  const next = input.content !== undefined
    ? input.content
    : input.operations?.length
      ? applyMemoryOperations(current, input.operations)
      : (() => { throw new MemoryError('需要提供 content 或 operations') })()

  if (next === current) {
    return { target: input.target, revision: currentRevision, chars: countChars(current) }
  }

  // 统一在服务层校验体积与全局画像预算，覆盖 content 与 operations 两条写入路径；
  // 顺序上先做整体预算、再做单条事实校验：整体超预算（如全局画像 >5000 码元）是更高优先级的
  // ProfileBudgetExceededError 契约，不能让单条 1000 码元上限把它抢先覆盖。
  assertWritableMemoryContent(input.target, next)
  if (input.content !== undefined) assertMemoryContentEntries(next)
  if (!existsSync(filePath) && input.target !== GLOBAL_PROFILE_TARGET && input.target !== PROJECT_INDEX_TARGET) {
    console.log(`[记忆] 将创建新的记忆主题：${input.target}`)
  }
  const snapshotId = snapshotMemory(filePath, input.target, current, input.summary)
  writeMemoryFileText(filePath, next)
  return {
    target: input.target,
    revision: hashContent(next),
    chars: countChars(next),
    ...(snapshotId ? { snapshotId } : {}),
  }
}

// ===== 检索 =====

/**
 * 纯本地词法检索：不引入 SQLite / 向量 / 新依赖，也不做同义词与语义联想。
 *
 * 分词规则：
 * - CJK 连续串：单字与双字整体保留；三字以上拆成 2-gram（中文无空格，2-gram 是召回与噪声的均衡点）；
 * - ASCII：完整 token 原样保留（`0.19.141`、`k3.1-pro`、`apps/.../memory-service.ts`），
 *   并额外拆出 `. _ : / \\ -` 分隔子段，避免查「子目录名」时完全摸不到；
 * - 其他文字（希腊、西里尔、泰、希伯来等）：按空白/标点成词后整词匹配，
 *   不在这些文字上做 2-gram，但也不允许它们变成搜不到的隐式空洞。
 *
 * 打分与会话无关、可重复：命中权重按查询词去重后累加（同一词出现多次不会加权），
 * 再用查询覆盖率（命中权重 / 查询总权重）抑制「长查询里只中一个低权重碎片」的噪声行；
 * 完整 CJK 串另给整串权重，保证完整短语优先于零散 2-gram。
 * 排序依次比较得分、行文本长度（同等命中下更聚焦的行靠前）、来源与行号，结果确定。
 */
const CJK_BIGRAM_WEIGHT = 1.2
const CJK_SINGLE_WEIGHT = 0.8
const CJK_DOUBLE_WEIGHT = 1.6
const CJK_PHRASE_WEIGHT = 3
const ASCII_FULL_TOKEN_WEIGHT = 5
const ASCII_SUB_TOKEN_WEIGHT = 1.2
/** 其他文字整词（如俄文/希腊文/泰文单词）权重：与 ASCII 完整 token 同等对待。 */
const OTHER_WORD_WEIGHT = 5
/** ASCII 完整 token（含版本号、路径）；后续子段按 `. _ : / \\ -` 拆开。 */
const ASCII_RUN_PATTERN = /[a-z0-9][a-z0-9._:/\\-]*/g
const ASCII_SEPARATOR_PATTERN = /[._:/\\-]+/
const ASCII_TRAILING_SEPARATOR_PATTERN = /[._:/\\-]+$/

type MemoryQueryTermKind = 'cjk' | 'ascii-full' | 'ascii-sub' | 'word'

interface MemoryQueryTerm {
  kind: MemoryQueryTermKind
  text: string
  weight: number
}

interface MemoryQuery {
  /** 去重后的查询词；同一词只计一次权重。 */
  terms: MemoryQueryTerm[]
  /** 查询里完整出现的 CJK 串；整串命中另计权重，代表完整短语。 */
  phrases: string[]
  /** 查询侧总权重，用作覆盖率分母。 */
  totalWeight: number
}

function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
}

/** 把文本拆成 CJK 连续串与非 CJK 片段。 */
function cjkRuns(text: string): string[] {
  const runs: string[] = []
  let current = ''
  for (const char of text) {
    if (isCjkChar(char)) {
      current += char
      continue
    }
    if (current) {
      runs.push(current)
      current = ''
    }
  }
  if (current) runs.push(current)
  return runs
}

/** ASCII token 的分隔子段；单字符子段不单独参与匹配，避免把 `1` 当成有效关键词。 */
function asciiSubTokens(token: string): string[] {
  return token
    .split(ASCII_SEPARATOR_PATTERN)
    .filter((segment) => segment.length >= 2 && segment !== token)
}

function asciiTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(ASCII_RUN_PATTERN)) {
    const token = match[0].replace(ASCII_TRAILING_SEPARATOR_PATTERN, '')
    if (token) tokens.push(token)
  }
  return tokens
}

/**
 * 既不属于 CJK 也不属于 ASCII 的文字与符号：按空白和标点切分。
 * 保留 emoji、数学符号及非 ASCII 单字，避免旧 substring 查询能力回退。
 */
function otherWordTokens(text: string): string[] {
  const stripped = Array.from(text)
    .map((char) => (isCjkChar(char) || /[a-z0-9]/.test(char) ? ' ' : char))
    .join('')
  return stripped
    .split(/[\s\p{P}]+/u)
    .map((word) => word.trim())
    .filter(Boolean)
}

/** 一行的 ASCII 匹配词表：完整 token 与其分隔子段；子段按整词比较，避免 substring 误命中。 */
function lineAsciiTokens(loweredLine: string): Set<string> {
  const tokens = new Set<string>()
  for (const token of asciiTokens(loweredLine)) {
    tokens.add(token)
    for (const segment of asciiSubTokens(token)) tokens.add(segment)
  }
  return tokens
}

function buildMemoryQuery(query: string): MemoryQuery {
  const normalized = query.toLowerCase().trim()
  const terms: MemoryQueryTerm[] = []
  const phrases: string[] = []
  const seen = new Set<string>()

  const pushTerm = (kind: MemoryQueryTermKind, text: string, weight: number): void => {
    const key = `${kind}:${text}`
    if (seen.has(key)) return
    seen.add(key)
    terms.push({ kind, text, weight })
  }

  for (const run of cjkRuns(normalized)) {
    if (run.length === 1) {
      pushTerm('cjk', run, CJK_SINGLE_WEIGHT)
      continue
    }
    if (run.length === 2) {
      pushTerm('cjk', run, CJK_DOUBLE_WEIGHT)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      pushTerm('cjk', run.slice(index, index + 2), CJK_BIGRAM_WEIGHT)
    }
    if (!phrases.includes(run)) phrases.push(run)
  }

  for (const token of asciiTokens(normalized)) {
    pushTerm('ascii-full', token, ASCII_FULL_TOKEN_WEIGHT)
    for (const segment of asciiSubTokens(token)) {
      pushTerm('ascii-sub', segment, ASCII_SUB_TOKEN_WEIGHT)
    }
  }

  for (const word of otherWordTokens(normalized)) {
    pushTerm('word', word, OTHER_WORD_WEIGHT)
  }

  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0) + phrases.length * CJK_PHRASE_WEIGHT
  return { terms, phrases, totalWeight }
}

/** 单行得分：命中权重 × 覆盖率因子；无命中返回 0。 */
function scoreMemoryLine(query: MemoryQuery, line: string): number {
  if (query.totalWeight <= 0) return 0
  const lowered = line.toLowerCase()
  let matched = 0
  let tokens: Set<string> | undefined

  for (const term of query.terms) {
    if (term.kind === 'ascii-sub') {
      tokens ??= lineAsciiTokens(lowered)
      if (tokens.has(term.text)) matched += term.weight
      continue
    }
    // CJK 词与 ASCII 完整 token 都按子串命中：中文没有词边界，完整 token 允许落在更长的路径里。
    if (lowered.includes(term.text)) matched += term.weight
  }

  for (const phrase of query.phrases) {
    if (lowered.includes(phrase)) matched += CJK_PHRASE_WEIGHT
  }

  if (matched <= 0) return 0
  const coverage = Math.min(1, matched / query.totalWeight)
  // 覆盖率同时参与乘法，而不是只按命中个数/长度累加：
  // 长查询里只中一个低权重碎片时得分被压到最低，不会挤到高覆盖行前面。
  return Math.round(matched * (0.35 + 0.65 * coverage) * 10000) / 10000
}

function compareSearchHits(left: MemorySearchHit, right: MemorySearchHit): number {
  if (right.score !== left.score) return right.score - left.score
  if (left.text.length !== right.text.length) return left.text.length - right.text.length
  if (left.source !== right.source) return left.source < right.source ? -1 : 1
  return left.line - right.line
}

/**
 * 跨全局画像与项目记忆检索。逐行按词法权重打分，返回得分最高的行片段；
 * 不做模糊纠错与同义词语义联想，避免编造不存在的记忆。
 */
export function searchMemory(query: string, workspaceSlug?: string, limit = 20): MemorySearchHit[] {
  const memoryQuery = buildMemoryQuery(query)
  if (memoryQuery.totalWeight <= 0) return []
  const maxHits = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20), MAX_SEARCH_HITS)

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
      const score = scoreMemoryLine(memoryQuery, line)
      if (score <= 0) continue
      hits.push({ source: document.source, target: document.target, line: index + 1, text: line.trim(), score })
    }
  }

  return hits.sort(compareSearchHits).slice(0, maxHits)
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

/**
 * 写入前的统一预算校验：所有记忆正文都必须满足单文件字节上限；
 * 全局画像额外受常驻上下文预算约束（100 条事实 / 5000 UTF-16 码元）。
 */
function assertWritableMemoryContent(target: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryError(`记忆文件超过 512 KiB，请先按主题拆分：${target}`)
  }
  if (target === GLOBAL_PROFILE_TARGET) assertProfileBudget(content)
}

/** 统计正文里 `- ` 事实条目数，供全局画像预算校验。 */
function countProfileFacts(content: string): number {
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
 * 归档 journal：在移动正文之前落盘，记录恢复索引所需的全部信息。
 * 崩溃后启动期据此续跑；journal 本身走 safe-file 原子写。
 */
interface MemoryArchiveJournal {
  version: 1
  target: string
  themePath: string
  archivedTo: string
  themeRevision: string
  indexRevision: string
  indexContent: string
}

function archiveJournalPath(projectDir: string, target: string): string {
  // 用 URL 编码保持文件名唯一（中文主题不会都退化成同一个下划线），
  // target 已在校验阶段拒绝路径分隔符。
  return join(projectDir, ARCHIVE_JOURNAL_DIR_NAME, `${encodeURIComponent(target)}.json`)
}

function writeArchiveJournal(projectDir: string, journal: MemoryArchiveJournal): void {
  const journalPath = archiveJournalPath(projectDir, journal.target)
  mkdirSync(dirname(journalPath), { recursive: true })
  writeTextFileAtomic(journalPath, JSON.stringify(journal, null, 2))
}

function clearArchiveJournal(projectDir: string, target: string): void {
  try {
    unlinkSync(archiveJournalPath(projectDir, target))
  } catch {
    // journal 已不存在或清理失败：启动期会按当前文件状态幂等处理。
  }
}

/** journal 来自磁盘，恢复前必须重新校验目标与归档路径边界。 */
function isValidArchiveJournal(input: unknown, projectDir: string): input is MemoryArchiveJournal {
  if (!input || typeof input !== 'object') return false
  const journal = input as Partial<MemoryArchiveJournal>
  if (journal.version !== 1) return false
  const target = journal.target
  if (
    typeof target !== 'string'
    || !target.endsWith('.md')
    || target.startsWith('.')
    || target.includes('/')
    || target.includes('\\')
  ) {
    return false
  }
  if (journal.themePath !== join(projectDir, target)) return false
  if (typeof journal.indexRevision !== 'string' || typeof journal.indexContent !== 'string') return false
  if (typeof journal.themeRevision !== 'string') return false
  if (typeof journal.archivedTo !== 'string') return false
  const archiveRoot = join(projectDir, ARCHIVE_DIR_NAME)
  const relativeToArchive = relative(archiveRoot, journal.archivedTo)
  if (!relativeToArchive || relativeToArchive.startsWith('..') || isAbsolute(relativeToArchive)) return false
  if (basename(journal.archivedTo) !== target) return false
  return true
}

/**
 * 续跑单个 journal：按文件现状判断归档停在哪一步。
 *
 * - 主题仍在原位：移动尚未发生（或已回滚），保持原状并清掉 journal；
 * - 主题已移走且归档副本存在：补写索引（仅当索引仍停在原 revision）；
 * - 两者都不存在：无法自动恢复，保留 journal 供人工处理。
 */
function resumeArchiveJournal(slug: string, projectDir: string, journal: MemoryArchiveJournal): boolean {
  const themeExists = existsSync(journal.themePath)
  const archivedExists = existsSync(journal.archivedTo)

  if (!themeExists && archivedExists) {
    const indexFilePath = join(projectDir, PROJECT_INDEX_TARGET)
    const currentIndex = readMemoryFileAt(indexFilePath)
    if (currentIndex.revision === journal.indexRevision) {
      updateMemory({
        target: PROJECT_INDEX_TARGET,
        revision: journal.indexRevision,
        summary: `归档 ${journal.target} 后同步移除索引入口（崩溃恢复）`,
        content: journal.indexContent,
      }, slug)
      console.log(`[记忆] 已续跑未完成的主题归档：${journal.target}`)
    } else {
      console.warn(`[记忆] 归档 ${journal.target} 的索引已被外部修改，保留当前索引`)
    }
    return true
  }

  if (themeExists) {
    // 正文尚未移动；索引即使被改也不擅自覆盖用户内容。
    console.log(`[记忆] 主题 ${journal.target} 仍在原位，归档未完成移动，保持现状`)
    return true
  }

  console.warn(`[记忆] 主题 ${journal.target} 的正文与归档副本均不存在，保留 journal 待人工处理`)
  return false
}

interface MemoryArchiveRecoveryResult {
  /** 已自动处理并清理 journal 的目标。 */
  recovered: string[]
  /** 无法安全处理、保留 journal 的项目。 */
  skipped: string[]
}

/**
 * 启动期续跑所有遗留的归档 journal。
 *
 * 默认遍历已登记的工作区；测试可显式传入 slug 列表并使用注入的记忆根目录。
 */
export function recoverPendingMemoryArchives(workspaceSlugs?: string[]): MemoryArchiveRecoveryResult {
  const slugs = workspaceSlugs ?? listAgentWorkspaces().map((workspace) => workspace.slug)
  const recovered: string[] = []
  const skipped: string[] = []

  for (const slug of slugs) {
    const projectDir = projectMemoryDir(slug)
    const journalDir = join(projectDir, ARCHIVE_JOURNAL_DIR_NAME)
    if (!existsSync(journalDir)) continue
    for (const name of readdirSync(journalDir).filter((entry) => entry.endsWith('.json'))) {
      const journalPath = join(journalDir, name)
      try {
        const parsed: unknown = JSON.parse(readFileSync(journalPath, 'utf8'))
        if (!isValidArchiveJournal(parsed, projectDir)) {
          console.warn(`[记忆] 忽略非法的归档 journal：${journalPath}`)
          skipped.push(`${slug}:${name}`)
          continue
        }
        if (resumeArchiveJournal(slug, projectDir, parsed)) {
          unlinkSync(journalPath)
          recovered.push(`${slug}:${parsed.target}`)
        } else {
          skipped.push(`${slug}:${name}`)
        }
      } catch (error) {
        console.warn(`[记忆] 处理归档 journal 失败：${journalPath}`, error)
        skipped.push(`${slug}:${name}`)
      }
    }
  }

  return { recovered, skipped }
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

  // 先落 journal 再移动正文：即使 rename 与索引更新之间崩溃，
  // 启动期也能据 journal 续跑，不会留下「索引仍引用、正文已移走」的悬空状态。
  writeArchiveJournal(projectDir, {
    version: 1,
    target,
    themePath,
    archivedTo,
    themeRevision: revision,
    indexRevision,
    indexContent,
  })

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
      clearArchiveJournal(projectDir, target)
    } catch {
      // 回滚失败时保留 journal 与归档副本：启动期会按现状续跑或提示人工恢复。
    }
    throw error
  }

  clearArchiveJournal(projectDir, target)

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
