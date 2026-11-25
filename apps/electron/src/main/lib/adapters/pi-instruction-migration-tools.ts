/**
 * 项目规则组工具（7 个）与项目地图工具。
 *
 * 只在用户主会话注入：自动化、协作子会话与外部 Bridge 没有可解释的写入时机，
 * 也无人在场处理实质冲突，因此既不提供 Migrate，也不提供 Maintain。
 *
 * 顺序约束：Migrate 必须紧跟一次 Inspect，且两侧版本在此期间不得变化。
 */

import { join } from 'node:path'
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { normalizePathForCompare } from '@proma/shared'
import { getAgentWorkspacesDir } from '../config-paths'
import { getProjectFilesPath } from '../agent-workspace-manager'
import { getSessionCheckoutHistory } from '../agent-session-manager'
import {
  hasMemoryAssociation,
  memoryAssociationSection,
  withMemoryWriteLock,
  type ProjectMemoryContext,
} from '../project-memory-scaffold'
import {
  completeProjectMapReview,
  readProjectMapReviewState,
} from '../project-map-review'
import {
  instructionInspectionRevision,
  inspectInstructionMigration,
} from '../project-instruction-inspect'
import {
  mergeProjectInstructions,
  replanProjectInstructions,
  resumeProjectInstructions,
} from '../project-instruction-migration'
import {
  finishInstructionMaintenance,
  maintainProjectInstructions,
} from '../project-instruction-maintenance'
import type { ProjectInstructionContext } from '../project-instruction-state'

/** 只约束真正用到的 defineTool；与 Pi SDK 的泛型签名保持结构兼容。 */
interface ToolSdk {
  defineTool: (definition: never) => unknown
}

/** 组装工具上下文所需的会话信息。 */
interface InstructionToolContextInput {
  workspaceSlug?: string
  sessionId?: string
  agentCwd?: string
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'external'
  /** 已解析好的上下文优先，避免提示词与工具各自计算一次。 */
  instructionContext?: ProjectInstructionContext
}

const USER_FACING_NOTICE = '这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用。'

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: payload,
  } as AgentToolResult<unknown>
}

function memoryContext(ctx: ProjectInstructionContext): ProjectMemoryContext {
  return { projectRoot: ctx.projectRoot, workspaceSlug: ctx.workspaceSlug }
}

/** 会话当前是否直接工作在 worktree 里；此时规则迁移必须延后。 */
function activeWorktreePath(sessionId: string, agentCwd: string): string | undefined {
  const target = normalizePathForCompare(agentCwd)
  const history = getSessionCheckoutHistory(sessionId)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (entry?.kind === 'worktree' && normalizePathForCompare(entry.path) === target) return entry.path
  }
  return undefined
}

/**
 * 解析项目规则维护上下文。
 *
 * - 项目根默认取工作区登记的项目目录；会话在 worktree 中时以 worktree 为当前根，
 *   并把原 checkout 记为规范根，让迁移自动判定「需延后」；
 * - 自动化、委派与外部 Bridge 会话关闭写权限。
 */
export function resolveInstructionContext(input: InstructionToolContextInput): ProjectInstructionContext | undefined {
  if (input.instructionContext) return input.instructionContext
  if (!input.workspaceSlug) return undefined
  const canonicalProjectRoot = getProjectFilesPath(input.workspaceSlug)
  const worktree = input.sessionId && input.agentCwd
    ? activeWorktreePath(input.sessionId, input.agentCwd)
    : undefined
  const writable = input.triggeredBy !== 'automation'
    && input.triggeredBy !== 'delegation'
    && input.triggeredBy !== 'external'
  return {
    projectRoot: worktree ?? canonicalProjectRoot,
    canonicalProjectRoot,
    workspaceSlug: input.workspaceSlug,
    // 数据根可能已迁移：统一走 config-paths，禁止按 home 目录直拼。
    workspaceRoot: join(getAgentWorkspacesDir(), input.workspaceSlug),
    isWorktree: Boolean(worktree),
    allowInstructionMaintenance: writable,
    allowProfileMigration: writable,
  }
}

/** 项目规则迁移参数的严格 schema：版本必须来自 Inspect，正文上限 512 KiB。 */
const migrateParameters = Type.Object({
  targetRevision: Type.String({ minLength: 64, maxLength: 64, description: '来自最近一次 ProjectInstructionsInspect 的目标 revision。' }),
  sources: Type.Array(Type.Object({
    path: Type.String({ description: '旧外层规则文件绝对路径。' }),
    revision: Type.String({ minLength: 64, maxLength: 64, description: '该来源在 Inspect 时的 revision。' }),
  })),
  content: Type.String({ minLength: 1, maxLength: 524288, description: '语义合并后的完整 AGENTS.md 正文。' }),
  summary: Type.String({ minLength: 1, maxLength: 12000, description: '逐项保留、去重与冲突处理依据。' }),
})

/**
 * 构建 7 个项目规则与项目地图工具。
 *
 * 只读会话仍保留 Inspect：它没有任何写入副作用，能帮助解释当前状态。
 */
export function buildInstructionMigrationTools(sdk: ToolSdk, ctx: ProjectInstructionContext): unknown[] {
  const defineTool = sdk.defineTool as (definition: unknown) => unknown
  const lockKey = `${ctx.workspaceRoot}\u0000instruction-maintenance`
  let inspectedMigrationRevision: string | undefined
  let inspectedMapRevision: string | undefined

  const definitions: Array<{ name: string; definition: unknown }> = [
    {
      name: 'ProjectInstructionsMaintain',
      definition: defineTool({
        name: 'ProjectInstructionsMaintain',
        label: '自动完善项目协作能力',
        description: 'One-time product-authorized project setup, including a first greeting. Preserve user files; initialize missing AGENTS.md and required memory, migrate unambiguous legacy rules, verify and persist completion. If needs-merge is returned, Inspect and semantically Migrate; ask only for unresolved substantive conflicts. A ready result is already verified: do not repeatedly inspect or initialize. Only announce userFacingNotice if present; changed=false is not a new optimization. Respect explicit read-only requests and plan mode. Never claim completion for needs-merge/deferred/errors.',
        parameters: Type.Object({}),
        async execute() {
          const state = await withMemoryWriteLock(lockKey, () => maintainProjectInstructions(ctx))
          const notice = state.status === 'ready' && state.changed ? { userFacingNotice: USER_FACING_NOTICE } : {}
          return jsonToolResult({ ...state, ...notice })
        },
      }),
    },
    {
      name: 'ProjectInstructionsInspect',
      definition: defineTool({
        name: 'ProjectInstructionsInspect',
        label: '读取项目规则与旧外层规则',
        description: 'Read the canonical project AGENTS.md and all legacy outer workspace AGENTS.md variants, revisions and pending migration IDs. Read both before merging. No writes or automatic conflict resolution. A worktree session reports deferred migration to the original project root.',
        parameters: Type.Object({}),
        async execute() {
          const state = inspectInstructionMigration(ctx)
          inspectedMigrationRevision = instructionInspectionRevision(ctx)
          return jsonToolResult(state)
        },
      }),
    },
    {
      name: 'ProjectInstructionsMigrate',
      definition: defineTool({
        name: 'ProjectInstructionsMigrate',
        label: '合并旧规则到项目 AGENTS.md',
        description: 'After ProjectInstructionsInspect, submit a semantic merge of both rule files: preserve valid requirements, deduplicate, resolve conflicts using evidence or ask the user before committing. Never concatenate contradictory requirements or prefer newer mtime. Retain any existing CLAUDE.md entry when creating AGENTS.md. Provide every source path/revision exactly as inspected. Saves recovery history, writes/verifies the project file, then archives legacy files outside native discovery. Do not manually delete legacy files. Only user project work in the original project checkout may migrate.',
        parameters: migrateParameters,
        async execute(_toolCallId: string, params: unknown) {
          if (!inspectedMigrationRevision || inspectedMigrationRevision !== instructionInspectionRevision(ctx)) {
            throw new Error('请先重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并。')
          }
          const proposal = params as { targetRevision: string; sources: Array<{ path: string; revision: string }>; content: string; summary: string }
          const memory = memoryContext(ctx)
          // 合并正文必须自带记忆关联块：迁移是一次性写入，不能等后续工具再补。
          const content = hasMemoryAssociation(memory, proposal.content)
            ? proposal.content
            : `${proposal.content.trimEnd()}\n\n${memoryAssociationSection(memory)}\n`
          return withMemoryWriteLock(lockKey, () => {
            const id = mergeProjectInstructions(ctx, { ...proposal, content })
            inspectedMigrationRevision = undefined
            const ready = finishInstructionMaintenance(ctx)
            return jsonToolResult({
              migrationId: id,
              status: 'ready',
              targetPath: ready.targetPath,
              verified: true,
              userFacingNotice: USER_FACING_NOTICE,
            })
          })
        },
      }),
    },
    {
      name: 'ProjectInstructionsResume',
      definition: defineTool({
        name: 'ProjectInstructionsResume',
        label: '恢复项目规则迁移',
        description: 'Resume a pending migration ID returned by ProjectInstructionsInspect. Accepts only original snapshots or already-written results; never overwrites new external edits. Original source and target contents remain archived. If a new edit conflicts, preserve files and explain the conflict instead of overwriting.',
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolCallId: string, params: unknown) {
          const outcome = await withMemoryWriteLock(lockKey, () => {
            const migrationId = resumeProjectInstructions(ctx, (params as { id: string }).id)
            const ready = finishInstructionMaintenance(ctx)
            return { migrationId, targetPath: ready.targetPath }
          })
          return jsonToolResult({
            status: 'ready',
            verified: true,
            userFacingNotice: USER_FACING_NOTICE,
            ...outcome,
          })
        },
      }),
    },
    {
      name: 'ProjectInstructionsReplan',
      definition: defineTool({
        name: 'ProjectInstructionsReplan',
        label: '保留新改动并重新合并规则',
        description: 'When resuming a pending migration fails because source or target was externally edited, retire the old plan while preserving ALL current target/source edits. Restore only missing legacy source files from the saved original snapshot, keeping previous history. Then use ProjectInstructionsInspect and semantically merge again with current revisions. This does not complete migration and must not be used to overwrite or discard conflicts.',
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolCallId: string, params: unknown) {
          const id = await withMemoryWriteLock(lockKey, () => replanProjectInstructions(ctx, (params as { id: string }).id))
          inspectedMigrationRevision = undefined
          return jsonToolResult({ supersededId: id, ...inspectInstructionMigration(ctx) })
        },
      }),
    },
    {
      name: 'ProjectMapInspect',
      definition: defineTool({
        name: 'ProjectMapInspect',
        label: '读取项目地图',
        description: 'Read the current project AGENTS.md, its character count, modification/review times and revision. Does not write files or mark a review complete. Read the Coach project-map reference and verify relevant project facts before completing a review.',
        parameters: Type.Object({}),
        async execute() {
          const state = readProjectMapReviewState(ctx.workspaceRoot, ctx.projectRoot)
          inspectedMapRevision = state.revision
          return jsonToolResult(state)
        },
      }),
    },
    {
      name: 'ProjectMapReviewComplete',
      definition: defineTool({
        name: 'ProjectMapReviewComplete',
        label: '记录项目地图检查完成',
        description: 'Record an actually completed project-map review in Proma metadata without modifying AGENTS.md. First use ProjectMapInspect and verify project facts. After edits, inspect and verify the updated file again. Do not call for a reminder alone, insufficient evidence, ordinary Q&A, plan mode or read-only tasks. Short or empty maps remain flagged even after a review.',
        parameters: Type.Object({
          revision: Type.String({ minLength: 64, maxLength: 64, description: 'Exact revision returned by the latest ProjectMapInspect in this run.' }),
          summary: Type.String({ minLength: 1, maxLength: 2000, description: 'What was actually checked, supporting facts and what was updated or why no update was necessary.' }),
        }),
        async execute(_toolCallId: string, params: unknown) {
          const input = params as { revision: string; summary: string }
          if (!inspectedMapRevision || input.revision !== inspectedMapRevision) {
            throw new Error('请先使用 ProjectMapInspect 读取并核验当前项目地图，再确认检查完成。')
          }
          const memory = memoryContext(ctx)
          if (!hasMemoryAssociation(memory, readProjectMapReviewState(ctx.workspaceRoot, ctx.projectRoot).content ?? '')) {
            throw new Error('项目地图缺少记忆维护方案或 MEMORY.md / 全局 user_profile.md 位置。请使用 MemoryInitialize 补齐，再重新读取核验。')
          }
          const record = completeProjectMapReview(ctx.workspaceRoot, ctx.projectRoot, input.revision, input.summary)
          inspectedMapRevision = undefined
          return jsonToolResult(record)
        },
      }),
    },
  ]

  // 只读会话仍可读取状态，但不提供任何写工具。
  const writable = ctx.allowInstructionMaintenance !== false && ctx.allowProfileMigration !== false
  return definitions
    .filter((item) => writable || item.name === 'ProjectInstructionsInspect' || item.name === 'ProjectMapInspect')
    .map((item) => item.definition)
}
