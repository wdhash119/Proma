/**
 * 项目能力维护：一次性把「项目规则 + 必需记忆 + 记忆关联」准备就绪。
 *
 * 这是产品已授权的基础维护，不是用户请求的迁移报告：
 * - 已有有效完成标记时立即返回 ready，不重复扫描；
 * - 只有唯一非空正文或没有旧规则时自动迁移，多个不同正文才要求语义合并；
 * - 记忆两文件缺失时建立真实脚手架，并在 `AGENTS.md` 挂上关联入口；
 * - 只读、计划或无人值守会话一律拒绝写入。
 */

import {
  ensureMemoryFiles,
  hasMemoryAssociation,
  linkProjectMemory,
  type ProjectMemoryContext,
} from './project-memory-scaffold'
import {
  inspectInstructionMigration,
  inspectLegacyProjectInstructions,
  readInstructionFile,
  type InstructionMigrationState,
} from './project-instruction-inspect'
import {
  assertInstructionWritable,
  mergeProjectInstructions,
  resumeProjectInstructions,
} from './project-instruction-migration'
import {
  instructionMemoryPaths,
  readInstructionReadyRecord,
  writeInstructionReadyRecord,
  type InstructionReadyRecord,
  type ProjectInstructionContext,
} from './project-instruction-state'

/** 维护结果：ready 表示已核验就绪，其余状态需要重新合并或延后。 */
export type InstructionMaintenanceStatus = 'ready' | 'needs-merge' | 'blocked' | 'deferred'

export interface InstructionMaintenanceResult extends Partial<InstructionMigrationState> {
  status: InstructionMaintenanceStatus
  changed?: boolean
  targetPath?: string
  completedAt?: number
}

/** 没有可用正文时建立的最小说明：只描述后续做法，不编造项目事实。 */
const FALLBACK_INSTRUCTION = `# 项目约定

项目事实随实际任务按已核验信息补充，不编造项目架构、命令或用户偏好。
`

function memoryContext(ctx: ProjectInstructionContext): ProjectMemoryContext {
  return { projectRoot: ctx.projectRoot, workspaceSlug: ctx.workspaceSlug }
}

/** 供工具层复用的写权限校验。 */
export { assertInstructionWritable }

/**
 * 结束维护：确认没有待合并来源后补齐记忆关联并记录完成。
 *
 * 写记录前重新检查一遍 `needed`：并行或中途出现的新来源不能被静默忽略。
 */
export function finishInstructionMaintenance(
  ctx: ProjectInstructionContext,
  changed = true,
): InstructionReadyRecord {
  assertInstructionWritable(ctx)
  ensureMemoryFiles(memoryContext(ctx))
  const state = inspectInstructionMigration(ctx)
  if (state.needed) throw new Error('旧项目规则尚未合并，不能记录项目能力维护完成。')
  linkProjectMemory(memoryContext(ctx))
  const target = readInstructionFile(state.target.path)
  if (!hasMemoryAssociation(memoryContext(ctx), target.content ?? '')) {
    throw new Error('项目规则记忆关联未就绪，不能记录项目能力维护完成。')
  }
  return writeInstructionReadyRecord(ctx, target.path, changed)
}

/**
 * 执行一次性项目能力维护。
 *
 * 顺序固定为：检查已有标记 → 处理未完成迁移 → 判断是否需要语义合并 →
 * 自动合并唯一正文 → 建立记忆脚手架并关联 → 写入完成标记。
 */
export function maintainProjectInstructions(ctx: ProjectInstructionContext): InstructionMaintenanceResult {
  assertInstructionWritable(ctx)
  const ready = readInstructionReadyRecord(ctx)
  if (ready) return { status: 'ready', changed: false, targetPath: ready.targetPath }

  let state = inspectInstructionMigration(ctx)
  if (state.issues.length > 0) return { status: 'blocked', ...state }
  if (state.deferred && state.needed) return { status: 'deferred', ...state }

  // 未完成迁移先恢复，恢复到一半仍失败时保持 pending，绝不清除用户文件。
  for (const id of state.pendingIds) resumeProjectInstructions(ctx, id)
  state = inspectInstructionMigration(ctx)

  const contents = distinctContents(state)
  if (state.sources.length > 0 && contents.length > 1) return { status: 'needs-merge', ...state }

  const memory = memoryContext(ctx)
  const memoryPaths = instructionMemoryPaths(ctx)
  const changed = state.sources.length > 0
    || !hasMemoryAssociation(memory, state.target.content ?? '')
    || !readInstructionFile(memoryPaths.index).content?.trim()
    || !readInstructionFile(memoryPaths.profile).content?.trim()

  if (state.sources.length > 0) {
    mergeProjectInstructions(ctx, {
      targetRevision: state.target.revision,
      sources: state.sources.map((source) => ({ path: source.path, revision: source.revision })),
      content: contents[0] ?? FALLBACK_INSTRUCTION,
      summary: '首次能力维护：保留唯一非空正文或去重相同正文；无规则冲突。空文件仅建立真实的基础说明。',
    })
  }

  const record = finishInstructionMaintenance(ctx, changed)
  return { status: 'ready', changed, targetPath: record.targetPath, completedAt: record.completedAt }
}

/** 去掉空白后的不同正文；顺序按「目标在前、来源在后」，便于优先保留项目现有规则。 */
function distinctContents(state: InstructionMigrationState): string[] {
  const files = [state.target, ...state.sources]
  const values = files
    .map((file) => file.content?.trim())
    .filter((value): value is string => Boolean(value))
  return [...new Set(values)]
}

/**
 * 生成注入系统提示的「首次项目能力维护」段落。
 *
 * 无需维护、只读会话或旧规则读取受阻时返回 undefined：受阻的情况由工具
 * 结果说明原因，不在提示词里反复催促。
 */
export function instructionMaintenancePrompt(ctx: ProjectInstructionContext): string | undefined {
  if (readInstructionReadyRecord(ctx)) return undefined
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) return undefined
  if (inspectLegacyProjectInstructions(ctx).issues.length > 0) return undefined
  return `## 首次项目能力维护（本轮自动完成）
这是产品已授权的一次性项目基础维护，用户只说 hi、你好或普通问答也触发，不需要用户选择或再次确认是否初始化。
这是后台基础维护，不是用户请求的迁移报告。维护前和工具之间不要输出说明、计划、路径或能力清单；先直接调用 ProjectInstructionsMaintain：工具会保留原文、建立缺少的 AGENTS.md / MEMORY.md / 全局 user_profile.md、关联维护方案，并自动处理空文件或唯一正文的迁移。不要把“建立规则”列为供用户选择的能力，也不要仅回复目录为空。
若返回 needs-merge，使用 ProjectInstructionsInspect 读取双方并调用 ProjectInstructionsMigrate 语义合并；只对无法凭证据解决的实质冲突询问用户。不要为这次基础维护运行全项目调查或为了 200 字编造事实。
完成工具会回读核验并记录持久状态；无需再调用项目规则 Inspect/MemoryInitialize/周检工具验证同一结果；这不限制独立待处理的旧画像整合及其 MemoryInspect/MemoryMigrateProfile。成功后正常回答用户，维护结果只允许在回复末尾附一句“这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用”。用户仅问候时，整条最终回复最多两句；不要列举能做什么，不要说项目目录为空，不要讲 AGENTS/MEMORY、迁移或初始化术语。未成功不能声称已优化。
这条一次性维护优先于普通问答不写知识的通用提示；用户明确只读/禁止写入和无人值守仍不执行。worktree 如有公共旧规则待迁移，保留并延后到原项目会话。`
}
