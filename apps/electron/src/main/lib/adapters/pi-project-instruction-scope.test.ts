import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ProjectInstructionSessionState } from '@proma/shared'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'
import { resolveProjectInstructions } from '../project-instruction-resolver'

const temporaryRoots: string[] = []

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'proma-instruction-scope-'))
  temporaryRoots.push(projectRoot)
  return projectRoot
}

function createController(
  projectRoot: string,
  resumeState?: ProjectInstructionSessionState,
  onStateChange?: (state: ProjectInstructionSessionState) => void,
): ProjectInstructionScopeController {
  return new ProjectInstructionScopeController({
    projectRoot,
    cwd: projectRoot,
    // 会话开始时已交付的指令与真实启动一致：只包含项目根当前解析出的来源。
    initialSources: resolveProjectInstructions({ projectRoot }).sources,
    resumeState,
    onStateChange,
  })
}

/** 记录扩展注册的 hook，验证不再注册 settle 续跑。 */
function createFakePi(): { handlers: Map<string, (event: never) => unknown>; api: ExtensionAPI } {
  const handlers = new Map<string, (event: never) => unknown>()
  const api = {
    on(event: string, handler: (event: never) => unknown) {
      handlers.set(event, handler)
    },
  } as unknown as ExtensionAPI
  return { handlers, api }
}

afterEach(() => {
  for (const projectRoot of temporaryRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

describe('非阻断的项目指令作用域控制器', () => {
  test('Given 子目录存在未注入的 AGENTS.md When 首次 read/edit/write/grep/find/ls Then 全部放行并激活待注入', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    const toolCases = [
      { toolName: 'read', directory: 'read-dir', path: join('read-dir', 'a.ts') },
      { toolName: 'edit', directory: 'edit-dir', path: join('edit-dir', 'a.ts') },
      { toolName: 'write', directory: 'write-dir', path: join('write-dir', 'a.ts') },
      { toolName: 'grep', directory: 'grep-dir', path: join('grep-dir', 'a.ts') },
      { toolName: 'find', directory: 'find-dir', path: 'find-dir' },
      { toolName: 'ls', directory: 'ls-dir', path: 'ls-dir' },
    ]
    for (const toolCase of toolCases) {
      mkdirSync(join(projectRoot, toolCase.directory))
      writeFileSync(join(projectRoot, toolCase.directory, 'AGENTS.md'), `# ${toolCase.directory} 规则\n`)
    }
    // grep 的目标必须是真实文件，解析器才会按文件所在目录求 scope。
    writeFileSync(join(projectRoot, 'grep-dir', 'a.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    // 根目录指令在会话开始已交付，普通调用直接放行。
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'README.md' } })).toBeUndefined()
    expect(controller.exportState().pendingSources).toHaveLength(0)

    // 首次访问每个未注入子目录都直接放行，绝不阻断。
    for (const toolCase of toolCases) {
      expect(controller.beforeToolCall({ toolName: toolCase.toolName, input: { path: toolCase.path } })).toBeUndefined()
    }
    expect(controller.exportState().pendingSources).toHaveLength(toolCases.length)

    // 下一轮 system prompt 注入全部激活来源，注入后收敛。
    const prompt = controller.appendPendingInstructions('基础系统提示词')
    for (const toolCase of toolCases) {
      expect(prompt).toContain(`${toolCase.directory} 规则`)
    }
    expect(controller.exportState().pendingSources).toHaveLength(0)
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('read-dir', 'a.ts') } })).toBeUndefined()
    expect(controller.exportState().pendingSources).toHaveLength(0)
  })

  test('Given 扩展注册 When 创建扩展 Then 只注册 tool_call 与 before_agent_start，不再注册 settle 续跑', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const states: ProjectInstructionSessionState[] = []
    const controller = createController(projectRoot, undefined, (state) => states.push(state))
    const { handlers, api } = createFakePi()
    controller.createExtension()(api)

    expect(handlers.has('tool_call')).toBe(true)
    expect(handlers.has('before_agent_start')).toBe(true)
    expect(handlers.has('agent_before_settle')).toBe(false)

    controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    const start = handlers.get('before_agent_start')!
    const result = start({ systemPrompt: '基础系统提示词' } as never) as { systemPrompt: string } | undefined
    expect(result?.systemPrompt).toContain('## 已按访问路径激活的项目指令')
    expect(result?.systemPrompt).toContain('子目录规则')
    // 同一来源只注入一次；第二次触发返回 undefined。
    expect(start({ systemPrompt: '基础系统提示词' } as never)).toBeUndefined()
    // flush 后上报状态：已交付含子树来源，pending 清空。
    expect(states).toHaveLength(1)
    expect(states[0]?.pendingSources).toHaveLength(0)
    expect(states[0]?.deliveredKeys.some((key) => key.includes('sub'))).toBe(true)
  })

  test('Given 上一轮激活未注入 When 新控制器带 resumeState 创建 Then 下一轮 system prompt 注入且仅一次', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const first = createController(projectRoot)
    first.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    const state = first.exportState()
    expect(state.pendingSources).toHaveLength(1)

    const second = createController(projectRoot, state)
    const prompt = second.appendPendingInstructions('基础系统提示词')
    expect(prompt).toContain('子目录规则')
    expect(second.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
    // 注入后再次触碰同一文件不会重新激活。
    second.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(second.exportState().pendingSources).toHaveLength(0)
  })

  test('Given 上一轮已注入 When 新控制器带 resumeState 创建 Then 跨 run 去重不再重复注入', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const first = createController(projectRoot)
    first.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    first.appendPendingInstructions('基础系统提示词')
    const state = first.exportState()
    expect(state.pendingSources).toHaveLength(0)
    expect(state.deliveredKeys.length).toBeGreaterThan(1)

    const second = createController(projectRoot, state)
    second.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(second.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
    expect(second.exportState().pendingSources).toHaveLength(0)
  })

  test('Given 已注入的 AGENTS.md 内容改变 When 再次访问 Then 按新哈希重新激活并注入', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v1\n')
    const controller = createController(projectRoot)

    controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(controller.appendPendingInstructions('基础系统提示词')).toContain('子目录规则 v1')

    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v2\n')
    controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(controller.exportState().pendingSources).toHaveLength(1)
    expect(controller.appendPendingInstructions('基础系统提示词')).toContain('子目录规则 v2')
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given 跨 run 后文件内容改变 When 带旧 state 的新控制器访问 Then 按新哈希重新激活', () => {
    const projectRoot = createProject()
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v1\n')
    const first = createController(projectRoot)
    first.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    first.appendPendingInstructions('基础系统提示词')

    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v2\n')
    const second = createController(projectRoot, first.exportState())
    second.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(second.appendPendingInstructions('基础系统提示词')).toContain('子目录规则 v2')
  })

  test('Given 无指令文件的子目录或项目外目标 When 访问 Then 不激活', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'other'))
    writeFileSync(join(projectRoot, 'other', 'a.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('other', 'a.ts') } })).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'ls', input: { path: 'other' } })).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'grep', input: { path: join('other', 'a.ts') } })).toBeUndefined()

    // 项目根之外的目标即使带指令文件也不进入 scope。
    const outsideRoot = createProject()
    writeFileSync(join(outsideRoot, 'AGENTS.md'), '# 项目外规则\n')
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join(outsideRoot, 'a.ts') } })).toBeUndefined()

    expect(controller.exportState().pendingSources).toHaveLength(0)
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given 指令元数据解析失败 When 调用工具 Then 仍然放行且不激活', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    const controller = createController(projectRoot)

    rmSync(projectRoot, { recursive: true, force: true })
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'a.ts' } })).toBeUndefined()
    expect(controller.exportState().pendingSources).toHaveLength(0)
  })

  test('Given 非法 resumeState When 创建控制器 Then 视为全新会话不影响激活', () => {
    const projectRoot = createProject()
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const controller = createController(projectRoot, { deliveredKeys: 'bad' } as unknown as ProjectInstructionSessionState)
    controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })
    expect(controller.appendPendingInstructions('基础系统提示词')).toContain('子目录规则')
  })
})

describe('legacy CLAUDE.md 非阻断迁移', () => {
  test('Given 目录仅有 legacy CLAUDE.md When edit/write Then 放行且下一轮 system prompt 注入迁移建议', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    writeFileSync(join(projectRoot, 'second.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    // 首次 edit/write 直接放行，不阻断也不终止本轮。
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'second.ts' } })).toBeUndefined()
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(1)

    const prompt = controller.appendPendingInstructions('基础系统提示词')
    expect(prompt).toContain('AGENTS.md')
    expect(prompt).toContain('CLAUDE.md')

    // 同一来源只提醒一次；模型继续修改其他文件也不会再次触发。
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(0)
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given legacy 提醒已消费 When 跨 run 恢复 Then 守卫持久不重复提醒', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const first = createController(projectRoot)
    first.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })
    first.appendPendingInstructions('基础系统提示词')
    const state = first.exportState()
    expect(state.consumedLegacyMigrations).toHaveLength(1)

    const second = createController(projectRoot, state)
    second.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })
    expect(second.exportState().pendingLegacyReminders).toHaveLength(0)
    expect(second.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given legacy 提醒尚未注入 When 跨 run 恢复 Then 下一轮仍注入一次', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const first = createController(projectRoot)
    first.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })
    const state = first.exportState()
    expect(state.pendingLegacyReminders).toHaveLength(1)

    const second = createController(projectRoot, state)
    expect(second.appendPendingInstructions('基础系统提示词')).toContain('项目指令迁移建议')
    expect(second.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given 目录仅有 legacy CLAUDE.md When 直接创建同目录 AGENTS.md Then 放行且不提示迁移', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    // 创建 AGENTS.md 本身就是迁移动作；此时磁盘上尚无 AGENTS.md，解析仍返回 legacy 来源。
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'AGENTS.md' } })).toBeUndefined()
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(0)

    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 新建 AGENTS.md\n')
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.appendPendingInstructions('基础系统提示词')).toContain('新建 AGENTS.md')
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(0)
  })

  test('Given legacy 迁移建议已注入 When legacy 内容改变 Then 防御守卫不重置，只按新哈希激活指令', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则 v1\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })
    expect(controller.appendPendingInstructions('基础系统提示词')).toContain('AGENTS.md')

    // 内容变化产生新哈希，作为普通指令重新激活并再注入一次；
    // 但 legacy 迁移守卫已消费，不会额外获得第二次迁移提醒。
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则 v2\n')
    controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })
    const prompt = controller.appendPendingInstructions('基础系统提示词')
    expect(prompt).toContain('legacy 规则 v2')
    expect(prompt).not.toContain('项目指令迁移建议')
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(0)
  })

  test('Given legacy 目录只做只读访问 When read Then 不提示迁移', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.exportState().pendingLegacyReminders).toHaveLength(0)
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })
})