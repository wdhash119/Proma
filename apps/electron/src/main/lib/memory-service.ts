/**
 * 记忆服务：全局画像 + 项目记忆的单条维护、检索与版本历史。
 *
 * 存储边界：
 * - 全局画像：`<configDir>/memory/user_profile.md`，跨工作区共享；
 * - 项目记忆：`<workspace>/memory/` 下的 `MEMORY.md`（纯路由索引）与 `memory/*.md`（按需主题）。
 *
 * 写入一律带 revision 校验，并在覆盖前把旧内容存成可恢复的历史快照；
 * 单条操作（add / update / remove）只改动命中的那一行 `- ` 事实，不再整篇重写。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

export class MemoryError extends Error {}

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
