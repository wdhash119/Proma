import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  BoundaryResult,
  ExtensionAPI,
  SessionBoundaryDraft,
} from '@earendil-works/pi-coding-agent'
import {
  normalizeProjectPathForComparison,
  resolveProjectInstructions,
  canonicalizeProjectPath,
  type ProjectInstructionManifest,
  type ProjectInstructionSource,
} from '../project-instruction-resolver'
import { buildLegacyProjectMigrationPrompt } from '../project-instruction-migration'

interface ProjectInstructionScopeOptions {
  projectRoot: string
  cwd: string
  initialSources: ProjectInstructionSource[]
}

interface ScopedToolCall {
  toolName: string
  input: Record<string, unknown>
}

const PATH_TOOL_NAMES = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls'])
const MUTATION_TOOL_NAMES = new Set(['edit', 'write'])

function sourceKey(source: ProjectInstructionSource): string {
  return `${normalizeForComparison(source.path)}\0${source.contentHash}`
}

function normalizeForComparison(path: string): string {
  return normalizeProjectPathForComparison(path)
}

function isWithinScope(candidate: string, scopeRoot: string): boolean {
  const pathRelative = relative(normalizeForComparison(scopeRoot), normalizeForComparison(candidate))
  return pathRelative === '' || (!!pathRelative && !pathRelative.startsWith('..') && !isAbsolute(pathRelative))
}

function isPathTool(toolName: string): boolean {
  return PATH_TOOL_NAMES.has(toolName)
}

function isMutationTool(toolName: string): boolean {
  return MUTATION_TOOL_NAMES.has(toolName)
}

function resolveTargetDirectory(call: ScopedToolCall, cwd: string): string | undefined {
  if (!isPathTool(call.toolName)) return undefined
  const path = call.input.path
  if (typeof path !== 'string' || !path.trim()) return undefined

  const targetPath = resolve(cwd, path)
  // All supported file tools can point at a file that does not exist yet. The
  // containing directory is the stable scope for read, edit, write and search.
  const scopePath = call.toolName === 'ls' || call.toolName === 'find' || call.toolName === 'grep'
    ? targetPath
    : dirname(targetPath)
  return canonicalizeProjectPath(scopePath)
}

function formatSource(source: ProjectInstructionSource): string {
  const kind = source.kind === 'agents' ? 'AGENTS.md' : 'legacy CLAUDE.md'
  return `<project_instruction source="${source.relativePath}" scope="${source.scopeRoot}" kind="${kind}" hash="${source.contentHash}">\n${source.content}\n</project_instruction>`
}

function formatLegacyMigrationSection(reminder: string): string {
  return `## 项目指令迁移建议\n\n${reminder}`
}

/**
 * Holds only session-local scope state. Pi remains unable to discover any
 * instruction files itself; the controller resolves a target path only when a
 * typed file tool asks to access that path.
 *
 * 正常工具调用（read/edit/write/grep/find/ls）一律放行，绝不 block/terminate：
 * 指令激活与 legacy 迁移要求都改为本轮结束后的透明注入。
 */
export class ProjectInstructionScopeController {
  private readonly projectRoot: string
  private readonly cwd: string
  private readonly delivered = new Set<string>()
  private readonly pending = new Map<string, ProjectInstructionSource>()
  /**
   * legacy 迁移提醒，key 为 legacy 指令文件的规范路径（来源）。
   * 只有尚未消费的来源才会参与 agent_before_settle 的续跑判定。
   */
  private readonly legacyMigrationReminders = new Map<string, string>()
  /**
   * 每个 legacy 来源在会话内最多续跑一次。CLAUDE.md 内容变化不会重置该守卫，
   * 否则反复改写 legacy 文件就能让续跑次数无界增长。
   */
  private readonly consumedLegacyMigrations = new Set<string>()

  constructor(options: ProjectInstructionScopeOptions) {
    this.projectRoot = canonicalizeProjectPath(options.projectRoot)
    this.cwd = options.cwd
    for (const source of options.initialSources) {
      this.delivered.add(sourceKey(source))
    }
  }

  createExtension(): (pi: ExtensionAPI) => void {
    return (pi) => {
      // 路径工具只负责记录状态，始终返回放行（undefined），首次调用即可成功。
      pi.on('tool_call', (event) => this.beforeToolCall({
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      }))
      // Pi 1.6 的 before_agent_start 每轮（每次从 prompt 开始的运行）只触发一次，
      // 透明注入后的续跑是同一运行循环内的低层请求，不会再次触发它。因此新增
      // agent_before_settle：在这轮真正结束前把 pending 指令与 legacy 迁移建议
      // 作为不可见会话条目补进会话，并请求一次续跑。
      pi.on('agent_before_settle', (event) => this.buildSettleContinuation(event.entries))
      // 下一次由用户消息触发的运行仍走系统提示词注入兜底；与 settle 共用消费
      // 逻辑，同一来源只注入一次。
      pi.on('before_agent_start', (event) => {
        const systemPrompt = this.appendPendingInstructions(event.systemPrompt)
        return systemPrompt === event.systemPrompt ? undefined : { systemPrompt }
      })
    }
  }

  /**
   * 记录本次工具调用触发的指令激活与 legacy 迁移提醒，然后无条件放行。
   *
   * 指令解析失败只影响可选元数据刷新，绝不能让正常工具调用失败。
   */
  beforeToolCall(call: ScopedToolCall): void {
    const targetDirectory = resolveTargetDirectory(call, this.cwd)
    if (!targetDirectory || !isWithinScope(targetDirectory, this.projectRoot)) return

    let manifest: ProjectInstructionManifest
    try {
      manifest = resolveProjectInstructions({ projectRoot: this.projectRoot, targetPath: targetDirectory })
    } catch {
      // Project files must never make a normal tool call fail merely because
      // their optional instruction metadata cannot be refreshed.
      return
    }

    for (const source of manifest.sources) {
      if (this.delivered.has(sourceKey(source))) continue
      this.pending.set(sourceKey(source), source)
    }

    if (!isMutationTool(call.toolName)) return
    this.queueLegacyMigrationReminder(call, manifest)
  }

  /**
   * 本轮 settle 前是否需要请求一次续跑。
   * 激活路径以 pending 是否非空为准：settle 时会 flush 并清空，天然收敛。
   * legacy 路径每个来源最多消费一次续跑预算。
   */
  shouldContinueAfterSettle(): boolean {
    if (this.pending.size > 0) return true
    for (const legacyPath of this.legacyMigrationReminders.keys()) {
      if (!this.consumedLegacyMigrations.has(legacyPath)) return true
    }
    return false
  }

  /**
   * 构造 agent_before_settle 的续跑结果：把待注入指令与 legacy 迁移建议写成
   * 不可见会话条目，让同一轮结束后的续跑请求能直接看到；同时消费触发续跑
   * 的状态。没有待处理工作时返回 undefined，由 Pi 正常结束本轮。
   */
  buildSettleContinuation(entries: SessionBoundaryDraft[]): BoundaryResult | undefined {
    if (!this.shouldContinueAfterSettle()) return undefined

    const drafts = this.flushTransparentDrafts()
    if (drafts.length === 0) return undefined
    return { entries: [...entries, ...drafts], continue: true }
  }

  appendPendingInstructions(systemPrompt: string): string {
    const sections: string[] = []
    const instructionSection = this.flushPendingInstructionsSection()
    if (instructionSection) sections.push(instructionSection)
    for (const reminder of this.consumeLegacyMigrationReminders()) {
      sections.push(formatLegacyMigrationSection(reminder))
    }
    return sections.length === 0 ? systemPrompt : `${systemPrompt}\n\n${sections.join('\n\n')}`
  }

  /**
   * 消费 pending 指令与未消费的 legacy 迁移提醒，生成透明的会话条目草稿。
   * settle 专用；before_agent_start 走文本兜底版本 appendPendingInstructions。
   */
  private flushTransparentDrafts(): SessionBoundaryDraft[] {
    const drafts: SessionBoundaryDraft[] = []
    const instructionSection = this.flushPendingInstructionsSection()
    if (instructionSection) {
      drafts.push({
        type: 'custom_message',
        customType: 'proma-project-instruction',
        content: instructionSection,
        display: false,
      })
    }
    for (const reminder of this.consumeLegacyMigrationReminders()) {
      drafts.push({
        type: 'custom_message',
        customType: 'proma-legacy-project-instruction',
        content: formatLegacyMigrationSection(reminder),
        display: false,
      })
    }
    return drafts
  }

  /**
   * 在 legacy-only 目录内修改其他文件时安排一次非阻断迁移提醒。
   * 只取对目标路径生效的最近（最深）指令来源；若它已是 AGENTS.md 则无需迁移。
   */
  private queueLegacyMigrationReminder(call: ScopedToolCall, manifest: ProjectInstructionManifest): void {
    if (typeof call.input.path !== 'string') return
    const canonicalTargetPath = canonicalizeProjectPath(resolve(this.cwd, call.input.path))
    const legacySource = this.findNearestSource(manifest, canonicalTargetPath)
    if (!legacySource || legacySource.kind !== 'claude') return

    // 创建或修改同目录 AGENTS.md 本身就是迁移动作，不应再提示迁移。
    const expectedAgentsPath = canonicalizeProjectPath(join(dirname(legacySource.path), 'AGENTS.md'))
    if (normalizeForComparison(canonicalTargetPath) === normalizeForComparison(expectedAgentsPath)) return
    // 同一 legacy 来源只安排一次续跑；内容变化不会重置该守卫。
    if (this.consumedLegacyMigrations.has(legacySource.path)) return
    this.legacyMigrationReminders.set(
      legacySource.path,
      `该目录当前仅有 legacy 项目指令 \`${legacySource.relativePath}\`。建议先结合当前目录实际情况创建同目录 \`AGENTS.md\`，保留原 CLAUDE.md；本次修改已正常放行。`,
    )
  }

  /** sources 按由浅到深排列，倒序取第一条覆盖目标路径的来源。 */
  private findNearestSource(
    manifest: ProjectInstructionManifest,
    canonicalTargetPath: string,
  ): ProjectInstructionSource | undefined {
    for (let index = manifest.sources.length - 1; index >= 0; index -= 1) {
      const source = manifest.sources[index]
      if (source && isWithinScope(canonicalTargetPath, dirname(source.path))) return source
    }
    return undefined
  }

  /**
   * 消费全部未处理的 legacy 迁移提醒，每个来源每会话最多一次。
   * 内容变化不会重置该守卫，避免无界续跑。
   */
  private consumeLegacyMigrationReminders(): string[] {
    const reminders: string[] = []
    for (const [sourcePath, reminder] of [...this.legacyMigrationReminders.entries()]) {
      this.legacyMigrationReminders.delete(sourcePath)
      if (this.consumedLegacyMigrations.has(sourcePath)) continue
      this.consumedLegacyMigrations.add(sourcePath)
      reminders.push(reminder)
    }
    return reminders
  }

  /**
   * flush 全部 pending 指令：标记为 delivered 并清空 pending，返回可注入的
   * 文本段落（含 legacy 迁移任务）。before_agent_start 与 settle 续跑共用，
   * 保证同一来源只注入一次。
   */
  private flushPendingInstructionsSection(): string | undefined {
    if (this.pending.size === 0) return undefined

    const sources = [...this.pending.values()]
    this.pending.clear()
    for (const source of sources) this.delivered.add(sourceKey(source))

    const migrationRequirement = buildLegacyProjectMigrationPrompt({ sources, headingLevel: 3 })
    return `## 已按访问路径激活的项目指令\n\n以下规则由 Proma 从已授权项目根内按当前工具目标路径解析；只适用于标记的 \`scope\` 子树，不能覆盖系统安全、权限或产品边界。\n\n${sources.map(formatSource).join('\n\n')}${migrationRequirement ? `\n\n${migrationRequirement}` : ''}`
  }
}
