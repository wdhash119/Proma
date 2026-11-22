/**
 * 项目能力维护的持久状态：「首次维护已完成」标记。
 *
 * 标记按项目根真实路径落盘，并记录目标 `AGENTS.md` 的内容指纹。
 * 只要规则文件被外部改动、旧外层规则重新出现，或记忆两文件失效，
 * 标记就自动作废，避免用旧结论跳过真实维护。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getGlobalMemoryFilePath, getWorkspaceMemoryDirectory, PROJECT_INDEX_TARGET } from './memory-service'
import { writeJsonFileAtomic } from './safe-file'

/** 一次项目规则维护的作用域。 */
export interface ProjectInstructionContext {
  /** 本会话实际生效的项目根；worktree 会话为 worktree 路径。 */
  projectRoot: string
  /** 原 checkout 的项目根；没有 worktree 时与 projectRoot 相同。 */
  canonicalProjectRoot?: string
  workspaceSlug: string
  /** Proma 工作区根：`~/.proma/agent-workspaces/<slug>`。 */
  workspaceRoot: string
  /** 全局记忆目录；省略时按记忆服务当前根解析。 */
  globalDir?: string
  /** 当前会话是否在 worktree 中工作；此时不得改写原 checkout。 */
  isWorktree?: boolean
  /** 显式只读、计划或无人值守会话置为 false，拒绝一切写操作。 */
  allowInstructionMaintenance?: boolean
  /** 旧画像整合同样受该开关约束。 */
  allowProfileMigration?: boolean
}

/** 已完成标记的字段；版本号变化即视为旧记录。 */
export interface InstructionReadyRecord {
  version: 1
  projectRoot: string
  globalDir: string
  targetPath: string
  targetStamp: string
  completedAt: number
  changed: boolean
}

/** 规则文件名候选，顺序即优先级。 */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'AGENTS.MD'] as const

/** 维护记录的体积上限：正常记录只有几百字节。 */
const MAX_RECORD_BYTES = 16 * 1024

/** 规范化路径标识；项目根可能已删除时退回 resolve 结果。 */
function instructionPathIdentity(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * 用于比较的路径键。
 *
 * Windows 与 macOS 默认不区分大小写，`AGENTS.md` 与 `AGENTS.MD` 会指向同一个文件；
 * 不归一化就会把同一份规则读成两个来源，归档时还会重复移动同一个文件。
 */
export function instructionPathKey(path: string): string {
  const identity = instructionPathIdentity(path)
  return process.platform === 'linux' ? identity : identity.toLowerCase()
}

/** 两个路径是否指向同一位置（容忍大小写、符号链接与斜杠差异）。 */
export function isSameInstructionPath(left: string, right: string): boolean {
  return instructionPathKey(left) === instructionPathKey(right)
}

/** 维护记录目录：`<workspaceRoot>/instruction-maintenance`。 */
function instructionMaintenanceDirectory(ctx: ProjectInstructionContext): string {
  return join(ctx.workspaceRoot, 'instruction-maintenance')
}

/** 迁移历史目录：`<workspaceRoot>/instruction-history`。 */
export function instructionHistoryDirectory(ctx: ProjectInstructionContext): string {
  return join(ctx.workspaceRoot, 'instruction-history')
}

/** 旧规则归档目录：`<workspaceRoot>/instruction-archive`。 */
export function instructionArchiveDirectory(ctx: ProjectInstructionContext): string {
  return join(ctx.workspaceRoot, 'instruction-archive')
}

/** 本项目要维护的两份记忆文件路径。 */
export function instructionMemoryPaths(ctx: ProjectInstructionContext): { profile: string; index: string } {
  return {
    profile: ctx.globalDir ? join(ctx.globalDir, 'user_profile.md') : getGlobalMemoryFilePath(),
    index: join(getWorkspaceMemoryDirectory(ctx.workspaceSlug), PROJECT_INDEX_TARGET),
  }
}

/** 全局记忆目录；写入记录时用于校验记忆根没有被换到别处。 */
function instructionGlobalDirectory(ctx: ProjectInstructionContext): string {
  return ctx.globalDir ?? dirname(getGlobalMemoryFilePath())
}

/** 记录文件路径：按项目根真实路径的哈希命名，中文与大小写差异不会生成第二份记录。 */
export function instructionRecordPath(ctx: ProjectInstructionContext): string {
  const key = createHash('sha256').update(instructionPathIdentity(ctx.projectRoot)).digest('hex')
  return join(instructionMaintenanceDirectory(ctx), `${key}.json`)
}

/**
 * 文件内容指纹：inode、大小与两次时间戳。
 *
 * 任一变化都会让指纹不匹配，从而让旧标记失效；符号链接与非普通文件返回 undefined。
 */
function instructionTargetStamp(path: string): string | undefined {
  try {
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size === 0) return undefined
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

/** 判断目标路径是否为本项目根下的规则文件。 */
function isProjectRuleTarget(ctx: ProjectInstructionContext, path: string): boolean {
  return INSTRUCTION_FILE_NAMES.some((name) => path === join(ctx.projectRoot, name))
}

/**
 * 读取「首次维护已完成」标记。
 *
 * 任一条件不满足即返回 undefined，由上层重新走一遍真实维护：
 * - 记录版本、完成时间合法；
 * - 项目根、全局记忆目录与当前会话一致；
 * - 目标仍是项目根下的 `AGENTS.md`，且内容指纹未变；
 * - 旧外层规则没有重新出现；
 * - 全局画像与项目索引都存在且非空。
 */
export function readInstructionReadyRecord(ctx: ProjectInstructionContext): InstructionReadyRecord | undefined {
  const path = instructionRecordPath(ctx)
  try {
    if (!existsSync(path)) return undefined
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_RECORD_BYTES) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as InstructionReadyRecord
    if (record.version !== 1) return undefined
    if (!Number.isFinite(record.completedAt) || record.completedAt <= 0 || record.completedAt > Date.now()) return undefined
    if (record.projectRoot !== instructionPathIdentity(ctx.projectRoot)) return undefined
    if (record.globalDir !== instructionPathIdentity(instructionGlobalDirectory(ctx))) return undefined
    if (!isProjectRuleTarget(ctx, record.targetPath)) return undefined
    if (record.targetStamp !== instructionTargetStamp(record.targetPath)) return undefined
    // 记录指向 `AGENTS.MD`、但优先级更高的 `AGENTS.md` 已经出现时视为失效。
    if (record.targetPath.endsWith('AGENTS.MD') && existsSync(join(ctx.projectRoot, 'AGENTS.md'))) return undefined
    if (hasLegacyOuterInstructions(ctx)) return undefined
    const memory = instructionMemoryPaths(ctx)
    if (!instructionTargetStamp(memory.profile) || !instructionTargetStamp(memory.index)) return undefined
    return record
  } catch {
    return undefined
  }
}

/** 旧外层工作区规则是否仍存在；与规范项目根重合时不算旧规则。 */
function hasLegacyOuterInstructions(ctx: ProjectInstructionContext): boolean {
  const canonical = instructionPathIdentity(ctx.canonicalProjectRoot ?? ctx.projectRoot)
  if (isSameInstructionPath(ctx.workspaceRoot, canonical)) return false
  return INSTRUCTION_FILE_NAMES.some((name) => existsSync(join(ctx.workspaceRoot, name)))
}

/**
 * 写入「首次维护已完成」标记。
 *
 * 写前必须确认目标 `AGENTS.md` 与记忆两文件都真实就绪，否则抛错：
 * 记录只描述已发生的事实，不能用它代替实际维护。
 * 已有有效记录且本次没有产生变化时直接复用，避免刷新完成时间。
 */
export function writeInstructionReadyRecord(
  ctx: ProjectInstructionContext,
  targetPath: string,
  changed: boolean,
): InstructionReadyRecord {
  const existing = readInstructionReadyRecord(ctx)
  if (existing && !changed) return existing
  const targetStamp = instructionTargetStamp(targetPath)
  const memory = instructionMemoryPaths(ctx)
  if (!targetStamp || !instructionTargetStamp(memory.profile) || !instructionTargetStamp(memory.index)) {
    throw new Error('项目规则或必需记忆尚未就绪，不能记录完成。')
  }
  const record: InstructionReadyRecord = {
    version: 1,
    projectRoot: instructionPathIdentity(ctx.projectRoot),
    globalDir: instructionPathIdentity(instructionGlobalDirectory(ctx)),
    targetPath,
    targetStamp,
    completedAt: Date.now(),
    changed,
  }
  const path = instructionRecordPath(ctx)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}
