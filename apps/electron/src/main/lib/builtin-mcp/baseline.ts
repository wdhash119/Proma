/**
 * Proma 内置 MCP 单一事实源加载层
 *
 * 唯一从 default-mcp.json 读取内置 MCP 定义的地方。注入器、UI catalog、
 * 系统提示词全部通过这里取 name / displayName / 约束，杜绝多处手写漂移。
 *
 * default-mcp.json 随构建编译进包（参考 channel-manager / agent-orchestrator
 * 的 `import pkg from 'package.json' with { type: 'json' }` 模式），
 * Proma 每次发布即覆盖升级，无需运行时同步到用户目录。
 */

import type { BuiltinMcpCategory, McpToolSummary } from '@proma/shared'
import manifest from './default-mcp.json' with { type: 'json' }

export interface BuiltinMcpDefinition {
  /** 内置能力 ID（如 'proma-cloud'）。 */
  id: string
  /** 运行时真实 server 名，下划线安全（= prompt = 注入 = UI 真实名） */
  name: string
  displayName: string
  description: string
  category: BuiltinMcpCategory
  /** internal=代码注入，不写入工作区 mcp.json */
  kind: 'internal'
  /** 是否允许用户删除（内置项恒为 false，删除护栏的事实源） */
  deletable: boolean
  /** 默认是否向 Agent 注入。 */
  defaultEnabled: boolean
  /** 是否提供开关（基础设施型如 proma-cloud 置 false） */
  toggleable: boolean
  tools: McpToolSummary[]
}

const DEFINITIONS: BuiltinMcpDefinition[] = (manifest.servers as unknown as BuiltinMcpDefinition[]).map((s) => ({
  ...s,
}))

/** 所有内置 MCP 定义（来自 default-mcp.json，按声明顺序） */
export function getBuiltinMcpDefinitions(): BuiltinMcpDefinition[] {
  return DEFINITIONS
}

/**
 * 虽不在 MCP 组件展示，仍由 Pi runtime 注入的第一方工具 server 名。
 * 它们必须继续保留，避免工作区 mcp.json 产生同名工具前缀冲突。
 */
const INTERNAL_RUNTIME_SERVER_NAMES = ['automation', 'collaboration']

/**
 * 内置或第一方 runtime 工具占用的全部保留名（id + 运行时 name）。
 * 工作区 mcp.json 不允许出现这些 key——任何同名条目都是误写/冲突，应在保存时剔除。
 */
export const RESERVED_BUILTIN_KEYS: ReadonlySet<string> = new Set([
  ...DEFINITIONS.flatMap((d) => [d.id, d.name]),
  ...INTERNAL_RUNTIME_SERVER_NAMES,
])
