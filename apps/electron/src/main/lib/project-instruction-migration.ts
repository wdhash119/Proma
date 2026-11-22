import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'
import {
  INSTRUCTION_FILE_NAMES,
  instructionArchiveDirectory,
  instructionHistoryDirectory,
  instructionPathKey,
  isSameInstructionPath,
  type ProjectInstructionContext,
} from './project-instruction-state'
import {
  inspectInstructionMigration,
  readInstructionFile,
  readInstructionMigrationJournal,
  type InstructionFileSnapshot,
  type InstructionMigrationJournal,
} from './project-instruction-inspect'
import type { ProjectInstructionSource } from './project-instruction-resolver'

interface LegacyMigrationPromptOptions {
  sources: ProjectInstructionSource[]
  headingLevel?: 2 | 3
}

function formatSourceEntry(source: ProjectInstructionSource): string {
  return `- \`${source.relativePath}\`（scope: \`${source.scopeRoot}\`，hash: \`${source.contentHash}\`）`
}

/**
 * 生成 legacy CLAUDE.md → AGENTS.md 的迁移要求。
 *
 * 指令解析器已经保证每个目录至多激活一个候选文件；因此传入的 legacy
 * source 均表示该目录当前没有优先级更高的 AGENTS.md。
 */
export function buildLegacyProjectMigrationPrompt(options: LegacyMigrationPromptOptions): string | undefined {
  const legacySources = options.sources.filter((source) => source.kind === 'claude')
  if (legacySources.length === 0) return undefined

  const activeAgents = options.sources.filter((source) => source.kind === 'agents')
  const activeAgentsSection = activeAgents.length > 0
    ? `\n\n本轮已激活、可能对迁移 scope 生效的 \`AGENTS.md\`：\n${activeAgents.map(formatSourceEntry).join('\n')}`
    : ''
  const heading = '#'.repeat(options.headingLevel ?? 2)

  return `${heading} Legacy 项目指令迁移任务

Proma 已从受信任项目根加载以下 legacy \`CLAUDE.md\` 兼容来源；每一项都需要迁移到**同目录**的 \`AGENTS.md\`：\n${legacySources.map(formatSourceEntry).join('\n')}${activeAgentsSection}

在修改对应 scope 内的其他项目文件前，逐个完成以下证据驱动的迁移：

1. **读取与核验**：先用 \`Read\` 阅读该 \`CLAUDE.md\` 原文；再读取已激活的父级 \`AGENTS.md\`、同目录刚出现的 \`AGENTS.md\`（若有），并用最小必要的 \`LS\` / \`Read\` 检查该 scope 的实际项目证据，例如 manifest、现有脚本、测试配置、目录入口和相邻文档。不要只凭文件名或旧规则猜测命令、架构和约定。
2. **提炼而非照抄**：保留 legacy 中仍可由当前项目证据支持的稳定规则、命令、架构边界、测试方式和协作流程；过时、冲突、一次性调试记录、个人偏好、密钥、长篇说明及仅适用于 Claude 的运行时措辞不得机械复制。无法核验且会实质影响工作方式的内容，先向用户说明或请求确认。
3. **按 AGENTS.md 最佳实践写入**：只写跨 Agent、跨会话有用且项目特有的内容；命令和路径必须已核验。根 \`AGENTS.md\` 放全项目通用规则；子目录 \`AGENTS.md\` 只放该子树的增量规则，引用父级规则而不重复。使用简短 Markdown 标题和可执行 bullet（常见为 Commands、Architecture、Conventions、Testing / Delivery），链接已有文档而非复制正文；避免通用模板，保持精炼、可维护。
4. **安全写入与报告**：只创建或最小增量修改目标 \`AGENTS.md\`，不整体覆盖已有内容；保留 \`CLAUDE.md\`，不得重命名或删除。完成后简短报告：读取的证据、保留/舍弃或待确认的规则、以及写入的 scope。

若项目现状与 legacy 规则冲突，以可验证的当前项目事实和更近 scope 的 \`AGENTS.md\` 为准；不要编造折中结论。`
}

// ===== 旧外层规则到项目 AGENTS.md 的受控迁移 =====

/** Migrate 的合并提案：正文由 Agent 语义合并后提交，版本来自 Inspect。 */
interface InstructionMergeProposal {
  targetRevision: string
  sources: Array<{ path: string; revision: string }>
  content: string
  summary: string
}

/** 只读、计划或无人值守会话不得执行项目规则维护。 */
export function assertInstructionWritable(ctx: ProjectInstructionContext): void {
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) {
    throw new Error('当前只读、计划或无人值守会话不执行项目能力维护。')
  }
}

/**
 * 迁移前的完整许可校验。
 *
 * 自动化、委派与只读会话都不能改写用户项目；worktree 会话必须回到原项目
 * 主目录处理，否则会把规则写进另一个 checkout。
 */
function assertMigrationAllowed(ctx: ProjectInstructionContext): void {
  assertInstructionWritable(ctx)
  const canonical = ctx.canonicalProjectRoot ?? ctx.projectRoot
  if (ctx.isWorktree === true || !isSameInstructionPath(ctx.projectRoot, canonical)) {
    throw new Error('请在原项目主目录的会话中合并外层规则；不能从 worktree 改写其他 checkout。')
  }
}

/** 迁移记录落盘；状态变化只重写这一份文件。 */
function writeInstructionMigrationJournal(ctx: ProjectInstructionContext, journal: InstructionMigrationJournal): void {
  const directory = instructionHistoryDirectory(ctx)
  mkdirSync(directory, { recursive: true })
  writeJsonFileAtomic(join(directory, `${journal.id}.json`), journal)
}

/** 归档目录：`instruction-archive/<时间戳>-<id 前缀>`，同一秒内多次迁移也不会互相覆盖。 */
function createArchiveDirectory(ctx: ProjectInstructionContext, id: string): string {
  const base = instructionArchiveDirectory(ctx)
  mkdirSync(base, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let candidate = join(base, `${stamp}-${id.slice(0, 8)}`)
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = join(base, `${stamp}-${id.slice(0, 8)}-${suffix}`)
    suffix += 1
  }
  mkdirSync(candidate, { recursive: true })
  return candidate
}

/** 校验记录描述的目标与来源仍然属于当前项目，避免旧记录串到别的项目。 */
function assertJournalMatchesContext(ctx: ProjectInstructionContext, journal: InstructionMigrationJournal): void {
  const allowedTargets = INSTRUCTION_FILE_NAMES.map((name) => join(ctx.projectRoot, name))
  const allowedSources = INSTRUCTION_FILE_NAMES.map((name) => join(ctx.workspaceRoot, name))
  if (journal.projectRoot !== instructionPathKey(ctx.projectRoot)) {
    throw new Error('迁移记录与当前项目不匹配，未修改文件。')
  }
  if (!allowedTargets.includes(journal.target.path)) {
    throw new Error('迁移记录与当前项目不匹配，未修改文件。')
  }
  const invalidSource = journal.sources.length === 0
    || journal.sources.some((file) => !allowedSources.includes(file.path) || isSameInstructionPath(file.path, journal.target.path))
  if (invalidSource) throw new Error('迁移记录与当前项目不匹配，未修改文件。')
}

/** 把旧外层规则移动到归档目录；归档前再次核对内容，变化时保留原文件。 */
function archiveLegacySources(
  ctx: ProjectInstructionContext,
  journal: InstructionMigrationJournal,
): string | undefined {
  const existing: InstructionFileSnapshot[] = []
  for (const source of journal.sources) {
    const current = readInstructionFile(source.path)
    if (current.content === null) continue
    if (current.revision !== source.revision) throw new Error('归档前外层规则发生变化，已保留源文件，请重新核对后再合并。')
    existing.push(current)
  }
  if (existing.length === 0) return undefined
  const directory = createArchiveDirectory(ctx, journal.id)
  for (const file of existing) {
    let destination = join(directory, basename(file.path))
    let suffix = 2
    while (existsSync(destination)) {
      destination = join(directory, `${basename(file.path)}.${suffix}`)
      suffix += 1
    }
    // 移动而非删除：用户仍能在工作区归档目录里找回原文。
    renameSync(file.path, destination)
  }
  return directory
}

/**
 * 执行一次迁移：写目标 → 回读核验 → 归档旧文件 → 记录完成。
 *
 * 任一步失败都保留可恢复的历史记录与原始文件，绝不留「已删除但未合并」的中间态。
 */
function applyInstructionMigration(ctx: ProjectInstructionContext, journal: InstructionMigrationJournal): string {
  assertJournalMatchesContext(ctx, journal)
  const currentTarget = readInstructionFile(journal.target.path)
  if (currentTarget.content !== journal.target.content && currentTarget.content !== journal.content) {
    throw new Error('项目 AGENTS.md 有新改动，不能用迁移记录覆盖。')
  }
  for (const source of journal.sources) {
    const current = readInstructionFile(source.path)
    if (current.content !== null && current.revision !== source.revision) {
      throw new Error('外层 AGENTS.md 有新改动，保留原文等待重新核对。')
    }
  }
  if (currentTarget.content !== journal.content) {
    mkdirSync(dirname(journal.target.path), { recursive: true })
    writeTextFileAtomic(journal.target.path, journal.content)
  }
  if (readInstructionFile(journal.target.path).content !== journal.content) {
    throw new Error('项目规则写后核验失败，已保留原文。')
  }
  const archiveDirectory = archiveLegacySources(ctx, journal)
  writeInstructionMigrationJournal(ctx, {
    ...journal,
    status: 'completed',
    completedAt: Date.now(),
    ...(archiveDirectory ? { archiveDirectory } : {}),
  })
  return journal.id
}

/** 目标不存在且存在旧 `CLAUDE.md` 时保留其入口，避免初始化时丢失既有规则。 */
function withLegacyClaudeEntry(projectRoot: string, content: string): string {
  const rulesPath = INSTRUCTION_FILE_NAMES.map((name) => join(projectRoot, name))
  if (rulesPath.some((path) => existsSync(path))) return content
  const legacy = ['CLAUDE.md', 'CLAUDE.MD'].find((name) => existsSync(join(projectRoot, name)))
  if (!legacy || content.includes(`](./${legacy})`)) return content
  return `${content.trimEnd()}

请先读取并遵循 [${legacy}](./${legacy}) 中的现有项目规则。
`
}

/**
 * 合并旧外层规则到项目 `AGENTS.md`。
 *
 * 调用方必须先 `ProjectInstructionsInspect`，并提交全部来源的当前版本：
 * 任一侧在读取后发生变化都会拒绝提交，避免用过期内容覆盖用户的新编辑。
 */
export function mergeProjectInstructions(
  ctx: ProjectInstructionContext,
  proposal: InstructionMergeProposal,
): string {
  assertMigrationAllowed(ctx)
  const state = inspectInstructionMigration(ctx)
  if (state.issues.length > 0) {
    throw new Error(`旧规则无法安全读取，未提交迁移：${state.issues.map((issue) => `${issue.path}：${issue.message}`).join('；')}`)
  }
  if (state.pendingIds.length > 0) {
    throw new Error(`请先恢复未完成的规则迁移：${state.pendingIds.join('、')}`)
  }
  if (state.sources.length === 0) throw new Error('没有待合并的外层 AGENTS.md。')
  const sourcesMatch = state.sources.length === proposal.sources.length
    && state.sources.every((source) => proposal.sources.some((item) => item.path === source.path && item.revision === source.revision))
  if (state.target.revision !== proposal.targetRevision || !sourcesMatch) {
    throw new Error('请重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并。')
  }
  if (!proposal.content.trim() || !proposal.summary.trim()) {
    throw new Error('请提供合并后的有效正文和逐项保留、去重、冲突处理依据。')
  }
  if (Buffer.byteLength(proposal.content, 'utf8') > 512 * 1024) {
    throw new Error('合并后的规则超过 512 KiB，请先按主题整理后重试。')
  }
  const content = withLegacyClaudeEntry(ctx.projectRoot, proposal.content)
  const journal: InstructionMigrationJournal = {
    version: 1,
    id: randomUUID(),
    projectRoot: instructionPathKey(ctx.projectRoot),
    target: state.target,
    sources: state.sources,
    content,
    summary: proposal.summary.trim(),
    status: 'pending',
    createdAt: Date.now(),
  }
  writeInstructionMigrationJournal(ctx, journal)
  return applyInstructionMigration(ctx, journal)
}

/**
 * 恢复未完成的迁移。
 *
 * 只接受「原文快照」或「已写入结果」两种当前状态；用户在此期间的新编辑
 * 一律保留，宁可失败也不覆盖。已完成记录直接返回，便于工具幂等重试。
 */
export function resumeProjectInstructions(ctx: ProjectInstructionContext, id: string): string {
  assertMigrationAllowed(ctx)
  const journal = readInstructionMigrationJournal(ctx, id)
  if (!journal) throw new Error('未找到该迁移记录，请重新使用 ProjectInstructionsInspect 检查。')
  if (journal.status === 'completed') return id
  if (journal.status === 'superseded') throw new Error('该迁移计划已退役，请重新使用 ProjectInstructionsInspect 读取当前两侧规则。')
  assertJournalMatchesContext(ctx, journal)
  return applyInstructionMigration(ctx, journal)
}

/**
 * 退役旧迁移计划，保留用户当前的所有编辑。
 *
 * 只把因迁移而缺失的旧外层文件从快照恢复回来，其余文件保持原样；
 * 之后必须重新 Inspect 并按最新版本再次合并。已完成或已退役的记录直接返回，
 * 不能借重规划复活已归档的来源。
 */
export function replanProjectInstructions(ctx: ProjectInstructionContext, id: string): string {
  assertMigrationAllowed(ctx)
  const journal = readInstructionMigrationJournal(ctx, id)
  if (!journal) throw new Error('未找到该迁移记录，请重新使用 ProjectInstructionsInspect 检查。')
  if (journal.status === 'completed') return id
  if (journal.status === 'superseded') return id
  assertJournalMatchesContext(ctx, journal)
  for (const source of journal.sources) {
    if (source.content === null) continue
    if (readInstructionFile(source.path).content === null) {
      mkdirSync(ctx.workspaceRoot, { recursive: true })
      writeTextFileAtomic(source.path, source.content)
    }
  }
  writeInstructionMigrationJournal(ctx, { ...journal, status: 'superseded' })
  return id
}
