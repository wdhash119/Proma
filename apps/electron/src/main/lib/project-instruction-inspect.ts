/**
 * 项目规则检查：读取项目根 `AGENTS.md` 与旧外层工作区规则，给出待迁移来源。
 *
 * 三条边界：
 * 1. 目标只有一个——项目根（worktree 会话为 worktree 根）下的 `AGENTS.md`；
 * 2. 来源只认 Proma 工作区根下的 `AGENTS.md` / `AGENTS.MD`，不向上越界；
 * 3. worktree 会话只报告「需延后」，绝不从 worktree 改写原 checkout。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTRUCTION_FILE_NAMES,
  instructionHistoryDirectory,
  instructionPathKey,
  isSameInstructionPath,
  readInstructionReadyRecord,
  type ProjectInstructionContext,
} from './project-instruction-state'

/** 单个规则文件的上限；超过即视为不可安全修改。 */
export const MAX_INSTRUCTION_BYTES = 512 * 1024

/** 迁移记录 JSON 的上限；正常记录只有几十 KB。 */
const MAX_MIGRATION_RECORD_BYTES = 4 * 1024 * 1024

interface InstructionIssue {
  path: string
  message: string
}

/** 一份规则文件快照；`content` 为 null 表示文件不存在。 */
export interface InstructionFileSnapshot {
  path: string
  content: string | null
  /** 内容哈希；不存在时为哈希空串，供乐观锁比对。 */
  revision: string
}

export interface InstructionMigrationState {
  target: InstructionFileSnapshot
  sources: InstructionFileSnapshot[]
  pendingIds: string[]
  issues: InstructionIssue[]
  /** 存在待迁移来源、未完成记录或读取异常。 */
  needed: boolean
  /** 当前会话在 worktree，迁移必须延后到原项目会话。 */
  deferred: boolean
}

/** 完成迁移后写入的迁移历史记录。 */
export interface InstructionMigrationJournal {
  version: 1
  id: string
  projectRoot: string
  target: InstructionFileSnapshot
  sources: InstructionFileSnapshot[]
  content: string
  summary: string
  status: 'pending' | 'completed' | 'superseded'
  createdAt: number
  completedAt?: number
  archiveDirectory?: string
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 项目根规则文件的期望路径：优先已存在的 `AGENTS.md`，否则按标准名给出路径。 */
export function projectInstructionsPath(projectRoot: string): string {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(projectRoot, name)
    if (existsSync(path)) return path
  }
  return join(projectRoot, 'AGENTS.md')
}

/**
 * 读取一份规则文件。
 *
 * 缺失返回 `content: null`；符号链接、目录、空文件与超大文件一律抛错，
 * 由上层归入 issues，不使用「当作不存在」的隐式降级。
 */
export function readInstructionFile(path: string): InstructionFileSnapshot {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { path, content: null, revision: hashContent('') }
    }
    throw error
  }
  if (stats.isSymbolicLink()) throw new Error('规则文件是符号链接，不可安全修改')
  if (!stats.isFile()) throw new Error('规则路径不是普通文件，不可安全修改')
  if (stats.size > MAX_INSTRUCTION_BYTES) {
    throw new Error(`规则文件超过 ${MAX_INSTRUCTION_BYTES / 1024} KiB，不可安全修改`)
  }
  const content = readFileSync(path, 'utf8')
  return { path, content, revision: hashContent(content) }
}

/** 读取迁移历史记录；对象缺失返回 undefined，内容异常抛错。 */
export function readInstructionMigrationJournal(
  ctx: ProjectInstructionContext,
  id: string,
): InstructionMigrationJournal | undefined {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  const path = join(instructionHistoryDirectory(ctx), `${id}.json`)
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('规则迁移记录无效。')
  if (stats.size > MAX_MIGRATION_RECORD_BYTES) throw new Error('规则迁移记录无效。')
  const journal = JSON.parse(readFileSync(path, 'utf8')) as InstructionMigrationJournal
  if (journal.version !== 1 || journal.id !== id) throw new Error('规则迁移记录无效。')
  return journal
}

/** 未完成的迁移 ID 列表，按创建时间排序。 */
export function pendingInstructionMigrations(ctx: ProjectInstructionContext): string[] {
  const directory = instructionHistoryDirectory(ctx)
  if (!existsSync(directory)) return []
  const pending: Array<{ id: string; createdAt: number }> = []
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!/^[a-f0-9-]{36}$/.test(id)) continue
    try {
      const journal = readInstructionMigrationJournal(ctx, id)
      if (journal?.status === 'pending') pending.push({ id, createdAt: journal.createdAt })
    } catch {
      // 损坏的记录不阻塞其他记录，后续 Inspect 会把异常报告给用户。
    }
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt).map((item) => item.id)
}

/**
 * 读取旧外层工作区规则。
 *
 * 已完成维护且标记仍有效时直接视为没有旧规则：标记本身已经把
 * 「旧文件重新出现」算作失效条件，因此这里不需要重复扫描。
 */
export function inspectLegacyProjectInstructions(
  ctx: ProjectInstructionContext,
): { sources: InstructionFileSnapshot[]; issues: InstructionIssue[] } {
  if (readInstructionReadyRecord(ctx)) return { sources: [], issues: [] }
  const canonical = ctx.canonicalProjectRoot ?? ctx.projectRoot
  // 工作区根与项目根是同一个目录时，那两份文件就是项目规则本身，不是旧规则。
  if (isSameInstructionPath(ctx.workspaceRoot, canonical)) return { sources: [], issues: [] }
  const targetPath = projectInstructionsPath(ctx.projectRoot)
  const seen = new Set<string>([instructionPathKey(targetPath)])
  const sources: InstructionFileSnapshot[] = []
  const issues: InstructionIssue[] = []
  for (const name of INSTRUCTION_FILE_NAMES) {
    const path = join(ctx.workspaceRoot, name)
    const key = instructionPathKey(path)
    // 大小写不敏感的文件系统上两个候选名可能指向同一份文件，只保留第一次命中。
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const file = readInstructionFile(path)
      if (file.content !== null) sources.push(file)
    } catch (error) {
      issues.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sources, issues }
}

/** 当前会话是否在 worktree 中工作；此时任何迁移都必须延后。 */
function isInstructionMigrationDeferred(ctx: ProjectInstructionContext): boolean {
  if (ctx.isWorktree === true) return true
  if (!ctx.canonicalProjectRoot) return false
  return !isSameInstructionPath(ctx.projectRoot, ctx.canonicalProjectRoot)
}

/**
 * 完整检查：目标、旧来源、未完成记录与是否需要延后。
 *
 * 这里只读不写；写入一律在 Migrate / Maintain 中完成。
 */
export function inspectInstructionMigration(ctx: ProjectInstructionContext): InstructionMigrationState {
  const { sources, issues } = inspectLegacyProjectInstructions(ctx)
  let target: InstructionFileSnapshot
  try {
    target = readInstructionFile(projectInstructionsPath(ctx.projectRoot))
  } catch (error) {
    target = {
      path: projectInstructionsPath(ctx.projectRoot),
      content: null,
      revision: hashContent(''),
    }
    issues.push({ path: target.path, message: error instanceof Error ? error.message : String(error) })
  }
  const pendingIds = pendingInstructionMigrations(ctx)
  return {
    target,
    sources,
    pendingIds,
    issues,
    needed: sources.length > 0 || pendingIds.length > 0 || issues.length > 0,
    deferred: isInstructionMigrationDeferred(ctx),
  }
}

/**
 * 一次检查的版本快照，供 Migrate 校验「是否先读过当前两侧规则」。
 *
 * 只包含路径与内容哈希：任何一侧变化都会让快照不再匹配。
 */
export function instructionInspectionRevision(ctx: ProjectInstructionContext): string {
  const state = inspectInstructionMigration(ctx)
  return createHash('sha256')
    .update(JSON.stringify({
      target: [state.target.path, state.target.revision],
      sources: state.sources.map((file) => [file.path, file.revision]),
    }))
    .digest('hex')
}
