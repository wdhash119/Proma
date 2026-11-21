/**
 * 项目记忆脚手架：首次项目能力维护所需的文件初始化与 `AGENTS.md` 记忆关联。
 *
 * 分工：
 * - 本模块负责「让必需文件存在」并「在项目规则里挂上记忆入口」；
 * - `memory-service.ts` 负责正文的单条维护、检索与历史版本。
 *
 * 三条硬约束：
 * 1. 只建立真实脚手架，不编造用户事实或项目架构；
 * 2. `AGENTS.md` 已有一段 `proma:memory` 关联时原位替换，不重复追加；
 * 3. 写入前保留既有内容，尤其是旧 `CLAUDE.md` 的入口引用。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { getGlobalMemoryFilePath, getWorkspaceMemoryDirectory, MAX_MEMORY_FILE_BYTES, PROJECT_INDEX_TARGET } from './memory-service'
import { writeTextFileAtomic } from './safe-file'

/** 一次项目能力维护的作用域。 */
export interface ProjectMemoryContext {
  /** 用户已授权的项目根；不得向上越界。 */
  projectRoot: string
  /** 当前工作区 slug，决定项目记忆目录。 */
  workspaceSlug: string
}

export interface ProjectMemoryPaths {
  /** 全局画像文件绝对路径。 */
  profile: string
  /** 项目记忆索引绝对路径。 */
  index: string
}

/** 记忆关联块在 AGENTS.md 中的边界标记。 */
const ASSOCIATION_BLOCK = /<!-- proma:memory:start -->[\s\S]*?<!-- proma:memory:end -->/
const ASSOCIATION_START = '<!-- proma:memory:start -->'
const ASSOCIATION_END = '<!-- proma:memory:end -->'
const MEMORY_MAINTENANCE_HEADING = '## 记忆维护'

/** 全局画像的初始脚手架：说明用途，不写入任何未经核验的用户事实。 */
const PROFILE_SCAFFOLD = `# 全局用户画像

此文件记录换个新项目也成立的个人背景与跨项目稳定偏好；每条例出来源与核验时间，不编造事实。

## 事实

`

/** 项目索引的初始脚手架：说明三层架构，不预置任何结论。 */
const INDEX_SCAFFOLD = `# 项目记忆索引

此文件维护主题入口和适用条件；详细内容按需读取。全局画像由运行时独立加载。

## 主题

暂无已确认的项目记忆。
`

/** 项目记忆的两条绝对路径。 */
export function getProjectMemoryPaths(ctx: ProjectMemoryContext): ProjectMemoryPaths {
  return {
    profile: getGlobalMemoryFilePath(),
    index: join(getWorkspaceMemoryDirectory(ctx.workspaceSlug), PROJECT_INDEX_TARGET),
  }
}

/**
 * 生成 `AGENTS.md` 中的记忆关联块。
 *
 * 用绝对路径链接，避免把用户带到错误的 worktree 或相对目录；
 * 同时声明三层预算，防止后续任务把细节堆进常驻文件。
 */
export function memoryAssociationSection(ctx: ProjectMemoryContext): string {
  const paths = getProjectMemoryPaths(ctx)
  return `${ASSOCIATION_START}
${MEMORY_MAINTENANCE_HEADING}

- **个人层（常驻）**：[user_profile.md](<${paths.profile}>)，跨项目共享，仅记录换个项目也成立的个人背景与稳定偏好。
- **项目护栏层（常驻）**：本文件（AGENTS.md，预算 ≤4000 非空白字符），仅保留不看就会在本项目犯错的子项目结构、常用命令与全局红线；具体模块细节、排障经过和某日状态快照一律下沉到项目 memory/。
- **专题手册层（按需）**：[MEMORY.md](<${paths.index}>) 仅维护一行一条的场景路由索引（预算 ≤3500 字符，不写长篇结论摘要），详细主题按索引按需读取；过期或已合并的存量文件（含历史 project-preferences.md）通过可恢复归档移出有效入口。读取不等于核验，不编造用户事实。
${ASSOCIATION_END}`
}

/** 判断既有内容是否已经挂了本项目记忆入口（含旧格式，只要路径与标题在）。 */
export function hasMemoryAssociation(ctx: ProjectMemoryContext, content: string): boolean {
  const paths = getProjectMemoryPaths(ctx)
  return content.includes(paths.index)
    && content.includes(paths.profile)
    && content.includes(MEMORY_MAINTENANCE_HEADING.replace(/^##\s*/, ''))
}

/**
 * 读取用于判断是否需要脚手架的文本文件。
 *
 * 只有「不存在」或「明确为空」才返回 undefined，允许调用方建立脚手架；
 * 符号链接、非普通文件、超过 512 KiB 或读取失败一律抛错——绝不能把读不到
 * 的用户内容当成空文件静默重建。阈值与记忆服务、规则检查保持一致。
 */
function readTextFile(path: string): string | undefined {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
  if (stats.isSymbolicLink()) throw new Error(`拒绝读写符号链接：${path}`)
  if (!stats.isFile()) throw new Error(`路径不是普通文件，不能安全初始化：${path}`)
  if (stats.size === 0) return undefined
  if (stats.size > MAX_MEMORY_FILE_BYTES) {
    throw new Error(`文件超过 ${MAX_MEMORY_FILE_BYTES / 1024} KiB，不能自动覆盖：${path}`)
  }
  return readFileSync(path, 'utf8')
}

/** 与规则检查一致的内容指纹，用于写入前校验是否被外部修改。 */
function contentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 确保全局画像与项目索引存在且具备真实脚手架。
 *
 * 返回本次实际创建的文件，供上层判断 `changed`；已存在且非空的文件绝不覆盖，
 * 符号链接、非普通文件、超大文件或读取失败时直接抛错中止，不做隐式重建。
 */
export function ensureMemoryFiles(ctx: ProjectMemoryContext): ProjectMemoryPaths & { created: string[] } {
  const paths = getProjectMemoryPaths(ctx)
  const created: string[] = []

  if (!readTextFile(paths.profile)) {
    mkdirSync(dirname(paths.profile), { recursive: true })
    writeTextFileAtomic(paths.profile, PROFILE_SCAFFOLD)
    created.push(paths.profile)
  }

  if (!readTextFile(paths.index)) {
    mkdirSync(dirname(paths.index), { recursive: true })
    writeTextFileAtomic(paths.index, INDEX_SCAFFOLD)
    created.push(paths.index)
  }

  return { ...paths, created }
}

/** 项目根下已存在的规则文件名，按优先顺序。 */
function findProjectRuleFile(projectRoot: string): { path: string; content: string } | undefined {
  for (const name of ['AGENTS.md', 'AGENTS.MD'] as const) {
    const path = join(projectRoot, name)
    const content = readTextFile(path)
    if (content !== undefined) return { path, content }
  }
  return undefined
}

/** 存在旧 `CLAUDE.md` 时为其保留入口，避免初始化 `AGENTS.md` 时丢失既有规则。 */
function legacyClaudeEntry(projectRoot: string): string | undefined {
  for (const name of ['CLAUDE.md', 'CLAUDE.MD'] as const) {
    if (existsSync(join(projectRoot, name))) return name
  }
  return undefined
}

/**
 * 在项目 `AGENTS.md` 中挂上记忆入口。
 *
 * - 已有 `proma:memory` 块则原位替换（幂等）；
 * - 文件不存在时创建最小 `AGENTS.md`，并在存在旧 `CLAUDE.md` 时保留其入口；
 * - 保留文件其余内容与其中的 `CLAUDE.md` 入口段落；
 * - 传入 `expectedRevision` 时先校验当前内容未被外部修改，避免用旧判断覆盖新编辑。
 */
export function linkProjectMemory(
  ctx: ProjectMemoryContext,
  options: { expectedRevision?: string } = {},
): { path: string; changed: boolean } {
  const existing = findProjectRuleFile(ctx.projectRoot)
  const path = existing?.path ?? join(ctx.projectRoot, 'AGENTS.md')
  const section = memoryAssociationSection(ctx)

  if (existing && options.expectedRevision && contentRevision(existing.content) !== options.expectedRevision) {
    throw new Error('项目规则在维护期间被外部修改，已停止写入，请重新检查。')
  }

  if (!existing) {
    const legacy = legacyClaudeEntry(ctx.projectRoot)
    const initial = `# 项目约定
${legacy ? `\n请先读取并遵循 [${legacy}](./${legacy}) 中的现有项目规则。\n` : ''}`
    mkdirSync(dirname(path), { recursive: true })
    writeTextFileAtomic(path, `${initial.trimEnd()}\n\n${section}\n`)
    return { path, changed: true }
  }

  // 已存在标记块时一律原位替换：记忆目录迁移后旧块里的绝对路径会失效，
  // 若按「路径是否匹配」判断会追加第二个块，产生互相矛盾的关联。
  if (ASSOCIATION_BLOCK.test(existing.content)) {
    const replaced = existing.content.replace(ASSOCIATION_BLOCK, () => section)
    if (replaced === existing.content) return { path, changed: false }
    writeTextFileAtomic(path, replaced)
    return { path, changed: true }
  }

  if (hasMemoryAssociation(ctx, existing.content)) return { path, changed: false }

  writeTextFileAtomic(path, `${existing.content.trimEnd()}\n\n${section}\n`)
  return { path, changed: true }
}

/** 去掉记忆关联块后的正文，用于字符预算统计。 */
export function stripMemoryAssociation(content: string): string {
  return content.replace(new RegExp(ASSOCIATION_BLOCK.source, 'g'), '')
}

/**
 * 记忆写入的进程内串行锁。
 *
 * 同一次会话里并发调用多个记忆工具时，避免两个写入读到同一 revision 后互相覆盖。
 * 只解决单进程并发；跨进程仍由 revision 乐观锁兜底。
 */
const writeChains = new Map<string, Promise<unknown>>()

export async function withMemoryWriteLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  // 记录链尾但不让它变成未处理的 rejection。
  writeChains.set(key, next.catch(() => undefined))
  try {
    return await next
  } finally {
    // 链已空时清理，避免长期增长。
    if (writeChains.get(key) === next || writeChains.size > 64) {
      const current = writeChains.get(key)
      if (current === next) writeChains.delete(key)
    }
  }
}

/** 供测试清理锁状态。 */
export function resetMemoryWriteLocksForTesting(): void {
  writeChains.clear()
}

/** 规范化的项目根标识，用于生成稳定的记录文件名。 */
export function projectRootIdentity(projectRoot: string): string {
  try {
    return realpathSync.native(projectRoot)
  } catch {
    return resolve(projectRoot)
  }
}
