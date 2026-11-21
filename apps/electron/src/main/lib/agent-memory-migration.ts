/**
 * 旧画像迁移：把一份历史 `user-profile.md` 语义合并进全局画像，并同步来源项目索引。
 *
 * 三条硬约束：
 * 1. 所有 revision 必须与调用方读到的一致；任何一处不匹配就返回
 *    `reconciliation_required`，并且**一个字都不写**；
 * 2. 写入前校验全局画像预算（≤100 条 `- ` 事实、≤5000 UTF-16 码元）；
 * 3. 旧画像不删除：成功后移动到 `.profile-migrations/archive/<id>/`，随时可以搬回来。
 *
 * 迁移日志 `<workspace>/.profile-migrations/<id>.json` 在真正写文件之前落盘，
 * 这样崩溃或并发冲突后还能用 `resumeId` 续跑、用 `replanId` 退役旧计划。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  PROFILE_MAX_CHARS,
  PROFILE_MAX_FACTS,
  PROJECT_INDEX_TARGET,
  ProfileBudgetExceededError,
  assertProfileBudget,
  findLegacyProfileLocation,
  getGlobalMemoryFilePath,
  getWorkspaceMemoryDirectory,
  getWorkspaceRootDirectory,
  readMemoryFileAt,
  writeMemoryFileText,
} from './memory-service'
import type { MemoryFileSnapshot } from './memory-service'
import { writeJsonFileAtomic } from './safe-file'

/** 迁移日志目录名；与记忆目录同层，避免混进可枚举的主题文件。 */
const MIGRATION_DIR_NAME = '.profile-migrations'
const MIGRATION_ARCHIVE_DIR_NAME = 'archive'
/** 迁移日志上限：远大于正常提案，但拒绝被写坏的巨型文件。 */
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const MIGRATION_ID_PATTERN = /^[a-f0-9-]{36}$/

/** 迁移运行上下文：只依赖工作区，便于测试注入隔离的记忆根目录。 */
export interface ProfileMigrationContext {
  workspaceSlug: string
  /** 默认允许；只读、自动化与协作子会话传 false。 */
  allowProfileMigration?: boolean
}

/** 一次语义合并提案；每个 revision 都来自上一次读取。 */
export interface ProfileMigrationProposal {
  sourceId: string
  sourceRevision: string
  globalRevision: string
  globalContent: string
  preferencesRevision: string
  /** `null` 表示本提案不保留项目偏好正文（仅当当前没有偏好正文时允许）。 */
  preferencesContent: string | null
  sourceIndexRevision: string
  sourceIndexContent: string
  indexRevision: string
  indexContent: string
  /** 逐项去重、项目范围与冲突处理依据；写进日志便于事后复核。 */
  rationale: string
}

/** 一次迁移要写的目标。 */
export type ProfileMigrationEditTarget = 'global' | 'preferences' | 'source-index' | 'index'

export interface ProfileMigrationEdit {
  target: ProfileMigrationEditTarget
  /** 目标文件绝对路径；日志里存路径，便于 `resumeId` 在同样的位置续跑。 */
  path: string
  /** 迁移前的正文；`null` 表示当时文件不存在。 */
  before: string | null
  after: string
}

export interface ProfileMigrationJournal {
  id: string
  status: 'pending' | 'completed' | 'superseded'
  workspaceSlug: string
  sourceId: string
  sourcePath: string
  sourceContent: string
  rationale: string
  createdAt: number
  updatedAt: number
  edits: ProfileMigrationEdit[]
  /** 成功后旧画像的归档路径。 */
  archivedSourceTo?: string
}

export interface ProfileMigrationSuccess {
  status: 'migrated'
  migrationId: string
  journalPath: string
  /** 迁移完成后旧画像所在位置（移动，不是删除）。 */
  archivedSourceTo: string
  writtenTargets: string[]
}

export interface ProfileMigrationReconciliation {
  status: 'reconciliation_required'
  saved: false
  operation: 'migration'
  /** 每条都是可执行的中文说明：哪个文件变了、该重新读什么。 */
  issues: string[]
  maxChars: number
  maxFacts: number
  next: string
}

/**
 * 写入过程中遇到目标被外部修改时的结果。
 *
 * 此前的目标可能已经落盘，因此不能再返回 `saved:false`；这里如实报告已处于
 * 目标状态的文件，并保留 pending 日志，调用方可以稍后 `resumeId` 续跑。
 */
export interface ProfileMigrationApplyPending {
  status: 'apply_incomplete'
  saved: true
  migrationId: string
  journalPath: string
  /** 已处于迁移后内容的目标（含本次写入与此前已完成的）。 */
  writtenTargets: string[]
  /** 因外部修改尚未写入的目标。 */
  pendingTargets: string[]
  issues: string[]
  next: string
}

export type ProfileMigrationResult =
  | ProfileMigrationSuccess
  | ProfileMigrationReconciliation
  | ProfileMigrationApplyPending

export interface ProfileMigrationReplan {
  status: 'needs-merge'
  supersededId: string
  next: string
}

const RECONCILIATION_NEXT =
  '迁移未执行。重新读取来源和画像，保留本次待合并事实及来源，整理至约 4000–4500 码元，再提交新的迁移提案。无法安全整理时保留原文并说明未完成。'

const APPLY_PENDING_NEXT =
  '迁移仅部分写入，记录保持 pending；请重新读取被外部修改的目标，处理冲突后用 resumeId 续跑，或用 replanId 退役旧计划。'

/** 迁移写入使用的文件读写抽象；生产固定用 memory-service 的原子实现，测试可注入以模拟写入期间的外部修改。 */
export interface ProfileMigrationIo {
  read: (path: string) => MemoryFileSnapshot
  write: (path: string, content: string) => void
}

const DEFAULT_MIGRATION_IO: ProfileMigrationIo = {
  read: readMemoryFileAt,
  write: writeMemoryFileText,
}

function assertProfileMigrationAllowed(ctx: ProfileMigrationContext): void {
  if (ctx.allowProfileMigration === false) {
    throw new Error('当前会话不允许整合用户画像；请在可写的用户项目会话中处理。')
  }
}

function reconciliation(issues: string[]): ProfileMigrationReconciliation {
  return {
    status: 'reconciliation_required',
    saved: false,
    operation: 'migration',
    issues,
    maxChars: PROFILE_MAX_CHARS,
    maxFacts: PROFILE_MAX_FACTS,
    next: RECONCILIATION_NEXT,
  }
}

/** 旧画像同层的索引文件；`.claude/memory` 布局下与项目索引不是同一个文件。 */
function legacyIndexPath(sourcePath: string): string {
  return join(dirname(sourcePath), PROJECT_INDEX_TARGET)
}

function preferencesPath(workspaceSlug: string): string {
  return join(getWorkspaceMemoryDirectory(workspaceSlug), 'project-preferences.md')
}

function migrationDirectory(workspaceSlug: string): string {
  return join(getWorkspaceRootDirectory(workspaceSlug), MIGRATION_DIR_NAME)
}

function journalPath(workspaceSlug: string, id: string): string {
  return join(migrationDirectory(workspaceSlug), `${id}.json`)
}

function archiveDirectory(workspaceSlug: string, id: string): string {
  return join(migrationDirectory(workspaceSlug), MIGRATION_ARCHIVE_DIR_NAME, id)
}

function resolveIdentity(path: string): string {
  return resolve(path)
}

/**
 * 校验提案里的内容约束。结构性错误直接抛（调用方写错了参数），
 * revision 冲突与预算超限走 `reconciliation_required`，因为那属于「环境变了」。
 */
function buildEdits(
  proposal: ProfileMigrationProposal,
  sourcePath: string,
  snapshots: {
    global: { path: string; content: string }
    preferences: { path: string; content: string }
    sourceIndex: { path: string; content: string }
    index: { path: string; content: string }
  },
): ProfileMigrationEdit[] {
  if (!proposal.globalContent.trim() || !proposal.rationale.trim()) {
    throw new Error('请提供合并后的全局画像，以及逐项去重、项目范围与冲突处理的依据（rationale）。')
  }
  assertProfileBudget(proposal.globalContent)

  const sourceIdentity = resolveIdentity(sourcePath)
  for (const content of [proposal.sourceIndexContent, proposal.indexContent]) {
    if (!content.trim()) {
      throw new Error('项目索引必须保留其他主题，并移除本次源画像的旧入口；其他待迁移画像的入口暂时保留。')
    }
    if (content.toLowerCase().includes(basename(sourcePath).toLowerCase())) {
      throw new Error('项目索引必须保留其他主题，并移除本次源画像的旧入口；其他待迁移画像的入口暂时保留。')
    }
  }

  const preferencesBefore = snapshots.preferences.content
  if (preferencesBefore.trim() && proposal.preferencesContent === null) {
    throw new Error('已有项目偏好不得在迁移中丢弃。')
  }
  if (proposal.preferencesContent !== null) {
    if (!proposal.preferencesContent.trim()) throw new Error('项目补充偏好必须有正文。')
    if (!proposal.indexContent.includes('project-preferences.md')) {
      throw new Error('项目补充偏好必须在项目 MEMORY.md 中建立 project-preferences.md 索引。')
    }
  }

  const sameIndex = resolveIdentity(snapshots.sourceIndex.path) === resolveIdentity(snapshots.index.path)
  if (sameIndex && proposal.sourceIndexContent !== proposal.indexContent) {
    throw new Error('源索引与项目索引为同一文件，内容必须一致。')
  }

  if (resolveIdentity(snapshots.global.path) === sourceIdentity) {
    throw new Error('迁移源画像与目标指向同一文件，请先调整迁移内容。')
  }

  const edits: ProfileMigrationEdit[] = [
    {
      target: 'global',
      path: snapshots.global.path,
      before: existsSync(snapshots.global.path) ? snapshots.global.content : null,
      after: proposal.globalContent,
    },
  ]
  if (proposal.preferencesContent !== null) {
    edits.push({
      target: 'preferences',
      path: snapshots.preferences.path,
      before: existsSync(snapshots.preferences.path) ? preferencesBefore : null,
      after: proposal.preferencesContent,
    })
  }
  edits.push({
    target: 'source-index',
    path: snapshots.sourceIndex.path,
    before: existsSync(snapshots.sourceIndex.path) ? snapshots.sourceIndex.content : null,
    after: proposal.sourceIndexContent,
  })
  if (!sameIndex) {
    edits.push({
      target: 'index',
      path: snapshots.index.path,
      before: existsSync(snapshots.index.path) ? snapshots.index.content : null,
      after: proposal.indexContent,
    })
  }

  // 两个编辑命中同一文件时必须给出同样的 before/after，否则写入顺序会互相打架。
  const byPath = new Map<string, ProfileMigrationEdit>()
  for (const edit of edits) {
    if (resolveIdentity(edit.path) === sourceIdentity) {
      throw new Error('迁移源画像与目标指向同一文件，请先调整迁移内容。')
    }
    if (Buffer.byteLength(edit.after, 'utf8') > 512 * 1024) {
      throw new Error(`迁移后的单个文件超过 512 KiB，请先按主题整理：${edit.path}`)
    }
    const identity = resolveIdentity(edit.path)
    const previous = byPath.get(identity)
    if (previous && (previous.before !== edit.before || previous.after !== edit.after)) {
      throw new Error('迁移目标指向同一文件，但合并内容不一致。')
    }
    byPath.set(identity, edit)
  }

  return [...byPath.values()]
}

/**
 * 执行一次旧画像语义合并。
 *
 * 返回 `reconciliation_required` 时保证没有写入任何文件：所有校验都在写之前完成。
 */
export function migrateProfile(
  ctx: ProfileMigrationContext,
  proposal: ProfileMigrationProposal,
): ProfileMigrationResult {
  assertProfileMigrationAllowed(ctx)

  const source = findLegacyProfileLocation(ctx.workspaceSlug, proposal.sourceId)
  if (!source) {
    throw new Error('源画像不存在或不属于当前工作区；请重新使用 MemoryInspect 读取来源。')
  }

  const memoryDir = getWorkspaceMemoryDirectory(ctx.workspaceSlug)
  const snapshots = {
    global: readMemoryFileAt(getGlobalMemoryFilePath()),
    preferences: readMemoryFileAt(preferencesPath(ctx.workspaceSlug)),
    sourceIndex: readMemoryFileAt(legacyIndexPath(source.path)),
    index: readMemoryFileAt(join(memoryDir, PROJECT_INDEX_TARGET)),
  }

  const issues: string[] = []
  const compare = (label: string, path: string, current: string, expected: string): void => {
    if (current === expected) return
    issues.push(`${label}在本次读取之后已变化，请重新读取：${path}`)
  }
  compare('源画像', source.path, source.revision, proposal.sourceRevision)
  compare('全局画像', snapshots.global.path, snapshots.global.revision, proposal.globalRevision)
  compare('项目偏好', snapshots.preferences.path, snapshots.preferences.revision, proposal.preferencesRevision)
  compare('源项目索引', snapshots.sourceIndex.path, snapshots.sourceIndex.revision, proposal.sourceIndexRevision)
  compare('当前项目索引', snapshots.index.path, snapshots.index.revision, proposal.indexRevision)
  if (issues.length > 0) return reconciliation(issues)

  let edits: ProfileMigrationEdit[]
  try {
    edits = buildEdits(proposal, source.path, {
      global: { path: snapshots.global.path, content: snapshots.global.content },
      preferences: { path: snapshots.preferences.path, content: snapshots.preferences.content },
      sourceIndex: { path: snapshots.sourceIndex.path, content: snapshots.sourceIndex.content },
      index: { path: snapshots.index.path, content: snapshots.index.content },
    })
  } catch (error) {
    if (error instanceof ProfileBudgetExceededError) return reconciliation([error.message])
    throw error
  }

  const id = randomUUID()
  const now = Date.now()
  const journal: ProfileMigrationJournal = {
    id,
    status: 'pending',
    workspaceSlug: ctx.workspaceSlug,
    sourceId: source.id,
    sourcePath: source.path,
    sourceContent: source.content,
    rationale: proposal.rationale,
    createdAt: now,
    updatedAt: now,
    edits,
  }

  writeJournal(ctx.workspaceSlug, journal)
  return applyMigration(ctx, journal)
}

function writeJournal(workspaceSlug: string, journal: ProfileMigrationJournal): string {
  const path = journalPath(workspaceSlug, journal.id)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, journal)
  return path
}

/** 读取并校验迁移日志；结构不完整或过大一律拒绝。 */
function readJournal(workspaceSlug: string, id: string): ProfileMigrationJournal | undefined {
  const path = journalPath(workspaceSlug, id)
  if (!existsSync(path)) return undefined
  const stats = lstatSync(path)
  if (!stats.isFile() || stats.size > MAX_JOURNAL_BYTES) {
    throw new Error('迁移日志无效或过大。')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('迁移日志无法解析。')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('迁移日志不完整。')
  const journal = parsed as Partial<ProfileMigrationJournal>
  if (journal.id !== id) throw new Error('迁移记录与 ID 不一致。')
  if (journal.status !== 'pending' && journal.status !== 'completed' && journal.status !== 'superseded') {
    throw new Error('迁移日志不完整。')
  }
  if (typeof journal.sourcePath !== 'string' || typeof journal.sourceContent !== 'string') {
    throw new Error('迁移日志不完整。')
  }
  if (!Array.isArray(journal.edits) || journal.edits.length === 0) throw new Error('迁移日志不完整。')
  return journal as ProfileMigrationJournal
}

/** 日志里的目标路径必须仍然落在当前工作区里，避免续跑时写到别的工作区。 */
function assertJournalTargets(ctx: ProfileMigrationContext, journal: ProfileMigrationJournal): void {
  if (journal.workspaceSlug !== ctx.workspaceSlug) throw new Error('迁移记录与当前工作区不一致，无法续跑。')
  const root = resolveIdentity(getWorkspaceRootDirectory(ctx.workspaceSlug))
  const memoryDir = resolveIdentity(getWorkspaceMemoryDirectory(ctx.workspaceSlug))
  const globalPath = resolveIdentity(getGlobalMemoryFilePath())
  const sourceIdentity = resolveIdentity(journal.sourcePath)
  if (!sourceIdentity.startsWith(`${root}/`) && !sourceIdentity.startsWith(`${root}\\`)) {
    throw new Error('迁移源不在当前工作区：' + journal.sourcePath)
  }
  // `.claude/memory` 旧布局下，来源索引与当前项目索引不是同一个文件，
  // 只能放行「该来源精确对应的 legacyIndexPath」；不能放宽到整个 `.claude` 目录。
  const legacyIndexIdentity = resolveIdentity(legacyIndexPath(journal.sourcePath))
  for (const edit of journal.edits) {
    const identity = resolveIdentity(edit.path)
    if (identity === globalPath) continue
    if (identity === legacyIndexIdentity) continue
    if (identity.startsWith(`${memoryDir}/`) || identity.startsWith(`${memoryDir}\\`)) continue
    throw new Error(`迁移目标不在当前工作区记忆目录：${edit.path}`)
  }
}

/**
 * 应用一份已落盘的迁移计划。
 *
 * 先统一检查所有目标是否仍是「上次读到的样子」，再开始写；
 * 因此返回 `reconciliation_required` 时目标文件一定没被改动。
 * 写入循环中若目标被外部修改，前序写入已经发生，此时改为返回
 * `apply_incomplete`（saved:true）并保留 pending 日志，绝不谎报零写入。
 */
function applyMigration(
  ctx: ProfileMigrationContext,
  journal: ProfileMigrationJournal,
  io: ProfileMigrationIo = DEFAULT_MIGRATION_IO,
): ProfileMigrationResult {
  assertJournalTargets(ctx, journal)

  const archiveDir = archiveDirectory(ctx.workspaceSlug, journal.id)
  const archivedSourceTo = join(archiveDir, basename(journal.sourcePath))

  const source = io.read(journal.sourcePath)
  let sourceAlreadyArchived = false
  if (source.content === '') {
    // 源缺失有两种可能：上一次已归档成功但日志尚未写 completed；或来源真的被删。
    // 只有归档副本存在且内容与日志一致才允许继续，否则禁止假完成。
    const archived = existsSync(archivedSourceTo) ? io.read(archivedSourceTo) : undefined
    if (archived && archived.content === journal.sourceContent) {
      sourceAlreadyArchived = true
    } else {
      return reconciliation([
        `源画像与归档副本均不可用，无法确认迁移来源：${journal.sourcePath}；请使用 replanId 恢复来源后重新合并。`,
      ])
    }
  } else if (source.content !== journal.sourceContent) {
    return reconciliation([
      `源画像已变化，保留待处理迁移和源文件：${journal.sourcePath}；请使用 replanId 保留新内容后重新合并。`,
    ])
  }

  const issues: string[] = []
  for (const edit of journal.edits) {
    if (edit.target === 'global') {
      try {
        assertProfileBudget(edit.after)
      } catch (error) {
        if (error instanceof ProfileBudgetExceededError) return reconciliation([error.message])
        throw error
      }
    }
    const current = io.read(edit.path)
    if (current.content !== (edit.before ?? '') && current.content !== edit.after) {
      issues.push(`迁移目标存在新改动，未覆盖：${edit.path}；请使用 replanId 保留新改动并重新合并。`)
    }
  }
  if (issues.length > 0) return reconciliation(issues)

  mkdirSync(archiveDir, { recursive: true })

  const writtenTargets: string[] = []
  for (let index = 0; index < journal.edits.length; index += 1) {
    const edit = journal.edits[index]
    if (!edit) continue
    const current = io.read(edit.path)
    if (current.content === edit.after) {
      // 已处于迁移后内容（此前中断或本次前序已写），无需重复写入。
      writtenTargets.push(edit.path)
      continue
    }
    if (current.content !== (edit.before ?? '')) {
      // 前序目标可能已落盘：不能返回 saved:false，如实报告进度并保持 pending。
      const pendingTargets = journal.edits.slice(index).map((item) => item.path)
      return {
        status: 'apply_incomplete',
        saved: true,
        migrationId: journal.id,
        journalPath: journalPath(ctx.workspaceSlug, journal.id),
        writtenTargets,
        pendingTargets,
        issues: [`迁移期间目标被外部修改，已写入的内容不回滚：${edit.path}`],
        next: APPLY_PENDING_NEXT,
      }
    }
    io.write(edit.path, edit.after)
    writtenTargets.push(edit.path)
  }

  for (const edit of journal.edits) {
    if (io.read(edit.path).content !== edit.after) {
      throw new Error(`迁移写后校验失败，保留源文件：${edit.path}`)
    }
  }

  // 旧画像移动到归档目录：默认 rename，同一磁盘上仍是原子动作；
  // 跨设备时退化为「复制 + 删除」，仍然不会丢正文。
  if (!sourceAlreadyArchived) {
    const latestSource = io.read(journal.sourcePath)
    if (latestSource.content === '') {
      // 写入期间源被外部删除：按日志原文恢复，避免来源缺失却报完成。
      io.write(journal.sourcePath, journal.sourceContent)
    } else if (latestSource.content !== journal.sourceContent) {
      throw new Error('归档前源画像已变化，保留源文件。')
    }
    try {
      renameSync(journal.sourcePath, archivedSourceTo)
    } catch {
      io.write(archivedSourceTo, journal.sourceContent)
      try {
        unlinkSync(journal.sourcePath)
      } catch {
        // 删除失败时源文件仍在，归档副本也已在，内容不会丢。
      }
    }
  }

  if (!existsSync(archivedSourceTo) || io.read(archivedSourceTo).content !== journal.sourceContent) {
    throw new Error(`归档副本缺失或内容不一致，迁移记录保持 pending：${archivedSourceTo}`)
  }

  journal.status = 'completed'
  journal.updatedAt = Date.now()
  journal.archivedSourceTo = archivedSourceTo
  const path = writeJournal(ctx.workspaceSlug, journal)

  return {
    status: 'migrated',
    migrationId: journal.id,
    journalPath: path,
    archivedSourceTo,
    writtenTargets: journal.edits.map((edit) => edit.path),
  }
}

/**
 * 仅测试：注入迁移写入的读写实现，用于稳定复现「写入循环中途目标被外部修改」的时序。
 * 生产路径始终使用 memory-service 的原子读写。
 */
export function applyProfileMigrationForTesting(
  ctx: ProfileMigrationContext,
  journal: ProfileMigrationJournal,
  io: ProfileMigrationIo,
): ProfileMigrationResult {
  return applyMigration(ctx, journal, io)
}

function successFromCompleted(ctx: ProfileMigrationContext, journal: ProfileMigrationJournal): ProfileMigrationResult {
  return {
    status: 'migrated',
    migrationId: journal.id,
    journalPath: journalPath(ctx.workspaceSlug, journal.id),
    archivedSourceTo: journal.archivedSourceTo ?? join(archiveDirectory(ctx.workspaceSlug, journal.id), basename(journal.sourcePath)),
    writtenTargets: journal.edits.map((edit) => edit.path),
  }
}

/** 续跑挂起的迁移；已完成时直接返回原结果。 */
export function resumeProfileMigration(
  ctx: ProfileMigrationContext,
  id: string,
): ProfileMigrationResult {
  assertProfileMigrationAllowed(ctx)
  if (!MIGRATION_ID_PATTERN.test(id)) throw new Error('迁移 ID 无效。')

  const journal = readJournal(ctx.workspaceSlug, id)
  if (!journal) throw new Error('迁移记录不存在。')
  if (journal.status === 'completed') return successFromCompleted(ctx, journal)
  if (journal.status === 'superseded') throw new Error('该迁移计划已退役，请重新读取并提交新的迁移提案。')

  return applyMigration(ctx, journal)
}

/**
 * 退役一份挂起的迁移计划：保留当前外部编辑、恢复缺失的来源文件，然后要求重新合并。
 */
export function replanProfileMigration(
  ctx: ProfileMigrationContext,
  id: string,
): ProfileMigrationReplan {
  assertProfileMigrationAllowed(ctx)
  if (!MIGRATION_ID_PATTERN.test(id)) throw new Error('迁移 ID 无效。')

  const journal = readJournal(ctx.workspaceSlug, id)
  if (!journal) throw new Error('迁移记录不存在。')
  if (journal.status === 'completed') throw new Error('迁移已完成，不能重新规划。')

  const nextMessage = '使用 MemoryInspect 重新读取当前来源和版本，保留新编辑后再次语义合并；原计划与 before/after 历史保留在迁移日志中。'
  if (journal.status === 'superseded') {
    return { status: 'needs-merge', supersededId: id, next: nextMessage }
  }

  assertJournalTargets(ctx, journal)

  // 来源文件被外部删掉时按日志里的原文恢复，避免「退役即丢内容」。
  if (!existsSync(journal.sourcePath)) {
    writeMemoryFileText(journal.sourcePath, journal.sourceContent)
  }

  journal.status = 'superseded'
  journal.updatedAt = Date.now()
  writeJournal(ctx.workspaceSlug, journal)

  return { status: 'needs-merge', supersededId: id, next: nextMessage }
}

/** 当前工作区里仍待处理的迁移 ID，最新在前。 */
export function listPendingProfileMigrations(ctx: ProfileMigrationContext): string[] {
  const dir = migrationDirectory(ctx.workspaceSlug)
  if (!existsSync(dir)) return []
  const ids: string[] = []
  for (const name of readdirNamesSafe(dir)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!MIGRATION_ID_PATTERN.test(id)) continue
    try {
      const journal = readJournal(ctx.workspaceSlug, id)
      if (journal?.status === 'pending') ids.push(id)
    } catch {
      // 损坏的日志不当作待处理计划，留给人工排查。
    }
  }
  return ids.sort().reverse()
}

function readdirNamesSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
