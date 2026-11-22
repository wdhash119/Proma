/**
 * 记忆组补充工具：`MemoryInitialize` / `MemoryArchive` / `MemoryMigrateProfile`。
 *
 * 这三个动作都会真实改动用户长期记忆，因此：
 * - 都必须带 revision，冲突时宁可返回 `reconciliation_required` 也不覆盖；
 * - 归档是移动到 `memory/.archive/`，画像迁移把来源移到 `.profile-migrations/archive/`，都可恢复；
 * - 无人值守会话（自动化 / 协作子会话）不提供画像整合工具，避免替用户改写跨项目画像。
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { serializePiToolResultPayload } from './pi-tool-result-json'
import {
  archiveMemoryTheme,
  type MemoryArchiveResult,
} from '../memory-service'
import {
  ensureMemoryFiles,
  linkProjectMemory,
  withMemoryWriteLock,
  type ProjectMemoryContext,
} from '../project-memory-scaffold'
import {
  listPendingProfileMigrations,
  migrateProfile,
  replanProfileMigration,
  resumeProfileMigration,
  type ProfileMigrationProposal,
  type ProfileMigrationResult,
} from '../agent-memory-migration'

export interface MemoryExtraToolsContext {
  /** 当前会话工作区；缺失时不提供项目记忆初始化与归档。 */
  workspaceSlug?: string
  /** 当前项目根，用于在 `AGENTS.md` 里挂记忆入口。 */
  projectRoot?: string
  /** 画像整合是否可用；自动化与协作子会话为 false。 */
  allowProfileMigration?: boolean
}

/** 只约束真正用到的 defineTool；与 Pi SDK 的泛型签名保持结构兼容。 */
interface ToolSdk {
  defineTool: (definition: never) => unknown
}

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text', text: serialized.text }],
    details: serialized.details,
  } as AgentToolResult<unknown>
}

function requireWorkspace(ctx: MemoryExtraToolsContext): string {
  if (!ctx.workspaceSlug) throw new Error('当前会话没有工作区，无法维护项目记忆。')
  return ctx.workspaceSlug
}

function projectMemoryContext(ctx: MemoryExtraToolsContext): ProjectMemoryContext {
  const workspaceSlug = requireWorkspace(ctx)
  if (!ctx.projectRoot) throw new Error('当前会话没有项目根目录，无法在 AGENTS.md 中建立记忆关联。')
  return { projectRoot: ctx.projectRoot, workspaceSlug }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 提案参数由模型给出；缺字段时按空串/null 处理，交给校验层给出中文原因。 */
function readProposal(value: unknown): ProfileMigrationProposal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const preferences = input.preferencesContent
  return {
    sourceId: readString(input.sourceId),
    sourceRevision: readString(input.sourceRevision),
    globalRevision: readString(input.globalRevision),
    globalContent: typeof input.globalContent === 'string' ? input.globalContent : '',
    preferencesRevision: readString(input.preferencesRevision),
    preferencesContent: typeof preferences === 'string' ? preferences : null,
    sourceIndexRevision: readString(input.sourceIndexRevision),
    sourceIndexContent: typeof input.sourceIndexContent === 'string' ? input.sourceIndexContent : '',
    indexRevision: readString(input.indexRevision),
    indexContent: typeof input.indexContent === 'string' ? input.indexContent : '',
    rationale: readString(input.rationale),
  }
}

const REVISION_SCHEMA = { minLength: 64, maxLength: 64 }
const CONTENT_SCHEMA = { minLength: 1, maxLength: 512 * 1024 }

export function buildMemoryExtraTools(sdk: ToolSdk, ctx: MemoryExtraToolsContext): unknown[] {
  // 三个工具都作用在当前工作区的记忆目录上；没有工作区就没有可维护的目标。
  if (!ctx.workspaceSlug) return []

  const defineTool = sdk.defineTool as (definition: unknown) => unknown

  const tools: unknown[] = [
    defineTool({
      name: 'MemoryInitialize',
      label: '建立必需记忆与项目关联',
      description: '确保全局 user_profile.md 与当前项目 MEMORY.md 存在，且只放真实脚手架；随后在项目 AGENTS.md 中追加明确的记忆维护段与绝对路径链接，保留既有规则与 CLAUDE.md 入口。只在可写的项目任务中使用，只读或计划阶段不要调用。完成后按需补充项目事实与已确认的用户事实，不要编造画像。',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult<unknown>> {
        const memoryCtx = projectMemoryContext(ctx)
        const created = ensureMemoryFiles(memoryCtx)
        const linked = await withMemoryWriteLock(`memory-link:${memoryCtx.workspaceSlug}`, () => linkProjectMemory(memoryCtx))
        return jsonToolResult({
          profilePath: created.profile,
          indexPath: created.index,
          createdFiles: created.created,
          rulesPath: linked.path,
          rulesChanged: linked.changed,
        })
      },
    }),
    defineTool({
      name: 'MemoryArchive',
      label: '归档过期记忆主题',
      description: '把确实过期或被取代的项目记忆主题（含旧的 project-preferences.md，在其有效规则已并入 AGENTS.md 或主题文件之后）可恢复地归档：把正文移动到 memory/.archive/<时间戳>/ 下，并用带版本校验的 MEMORY.md 覆盖移除它的活跃路由，其他主题入口保持不变。只有核实过证据才用，文件旧不等于过期。全局画像与 MEMORY.md 本身不能用归档处理，应改用 MemoryUpdate 逐条改写。',
      parameters: Type.Object({
        target: Type.String({ description: 'memory/ 下的主题文件名，例如 rollout.md 或 project-preferences.md。' }),
        revision: Type.String({ description: '最近一次 MemoryInspect 返回的主题 revision。', ...REVISION_SCHEMA }),
        indexRevision: Type.String({ description: '最近一次 MemoryInspect 返回的 MEMORY.md revision。', ...REVISION_SCHEMA }),
        indexContent: Type.String({ description: '移除该主题入口后的完整 MEMORY.md 正文；其他主题入口必须保留。', ...CONTENT_SCHEMA }),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> {
        const input = params as Record<string, unknown>
        const result: MemoryArchiveResult = archiveMemoryTheme(
          requireWorkspace(ctx),
          readString(input.target),
          readString(input.revision),
          readString(input.indexRevision),
          typeof input.indexContent === 'string' ? input.indexContent : '',
        )
        return jsonToolResult(result)
      },
    }),
  ]

  if (ctx.allowProfileMigration !== false) {
    tools.push(defineTool({
      name: 'MemoryMigrateProfile',
      label: '合并旧画像并更新原项目索引',
      description: '先按 knowledge-maintenance 指南与 MemoryInspect(sourceId) 读取旧画像，再语义合并一份旧画像。全局画像只保留简洁核心事实（最多 100 条、5000 UTF-16 码元），保留来源与无关事实，项目专属事实留在来源项目；绝不按文件修改时间裁决冲突。任一 revision 不匹配或超预算时返回 reconciliation_required 且不写入任何内容，此时保留待合并事实、整理后重新提交。挂起迁移用 resumeId 续跑；出现新改动用 replanId 退役旧计划后重新读取并合并。若写入中途目标被外部修改，返回 apply_incomplete（saved:true）并保留 pending 记录，可继续用 resumeId 续跑。migrationIssues、来源或挂起记录未清空时不得声称整合完成。',
      parameters: Type.Object({
        resumeId: Type.Optional(Type.String({ description: '要续跑的挂起迁移 ID。' })),
        replanId: Type.Optional(Type.String({ description: '要退役并重新规划的迁移 ID；退役后需重新 Inspect。' })),
        proposal: Type.Optional(Type.Object({
          sourceId: Type.String({ description: 'MemoryInspect 返回的旧画像来源 id。' }),
          sourceRevision: Type.String({ ...REVISION_SCHEMA }),
          globalRevision: Type.String({ ...REVISION_SCHEMA }),
          globalContent: Type.String({ description: '合并后的全局画像正文。', ...CONTENT_SCHEMA }),
          preferencesRevision: Type.String({ ...REVISION_SCHEMA }),
          preferencesContent: Type.Union([Type.String(CONTENT_SCHEMA), Type.Null()]),
          sourceIndexRevision: Type.String({ ...REVISION_SCHEMA }),
          sourceIndexContent: Type.String({ description: '来源项目索引正文；本次来源的旧入口必须移除。', ...CONTENT_SCHEMA }),
          indexRevision: Type.String({ ...REVISION_SCHEMA }),
          indexContent: Type.String({ description: '当前项目索引正文；本次来源的旧入口必须移除。', ...CONTENT_SCHEMA }),
          rationale: Type.String({ description: '逐项去重、项目范围与冲突处理依据。', minLength: 1, maxLength: 12_000 }),
        })),
      }),
      async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> {
        const input = params as Record<string, unknown>
        const supplied = [input.resumeId, input.replanId, input.proposal].filter(Boolean).length
        if (supplied !== 1) throw new Error('请提供 proposal、resumeId 或 replanId 中的一个。')

        const slug = requireWorkspace(ctx)
        const migrationCtx = { workspaceSlug: slug, allowProfileMigration: ctx.allowProfileMigration !== false }

        if (input.replanId) {
          return jsonToolResult(replanProfileMigration(migrationCtx, readString(input.replanId)))
        }

        const result: ProfileMigrationResult = await withMemoryWriteLock(
          `memory-migration:${slug}`,
          () => input.resumeId
            ? resumeProfileMigration(migrationCtx, readString(input.resumeId))
            : (() => {
                const proposal = readProposal(input.proposal)
                if (!proposal) throw new Error('请提供完整的迁移提案。')
                return migrateProfile(migrationCtx, proposal)
              })(),
        )
        if (result.status === 'migrated' || result.status === 'apply_incomplete') {
          return jsonToolResult({ ...result, pendingMigrations: listPendingProfileMigrations(migrationCtx) })
        }
        return jsonToolResult(result)
      },
    }))
  }

  return tools
}
