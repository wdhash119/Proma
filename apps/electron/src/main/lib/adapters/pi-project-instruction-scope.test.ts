import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectInstructionScopeController } from './pi-project-instruction-scope'
import { resolveProjectInstructions } from '../project-instruction-resolver'

const temporaryRoots: string[] = []

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'proma-instruction-scope-'))
  temporaryRoots.push(projectRoot)
  return projectRoot
}

function createController(projectRoot: string): ProjectInstructionScopeController {
  return new ProjectInstructionScopeController({
    projectRoot,
    cwd: projectRoot,
    // 会话开始时已交付的指令与真实启动一致：只包含项目根当前解析出的来源。
    initialSources: resolveProjectInstructions({ projectRoot }).sources,
  })
}

/** 汇总 settle 续跑中所有 extension 消息文本，便于断言注入内容。 */
function collectCustomMessageText(
  entries: { type: string; content?: string | Array<{ type: string; text?: string }> }[] | undefined,
): string {
  return (entries ?? [])
    .flatMap((entry) => entry.type === 'custom_message' ? [entry.content] : [])
    .flatMap((content) => {
      if (typeof content === 'string') return [content]
      if (Array.isArray(content)) {
        return content.map((part) => (part.type === 'text' ? part.text ?? '' : ''))
      }
      return []
    })
    .join('\n')
}

afterEach(() => {
  for (const projectRoot of temporaryRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

describe('非阻断的项目指令作用域控制器', () => {
  test('Given 子目录存在未注入的 AGENTS.md When 首次 read/edit/write/grep/find/ls Then 全部放行并透明注入一次', () => {
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
    expect(controller.shouldContinueAfterSettle()).toBe(false)

    // 首次访问每个未注入子目录都直接放行，绝不阻断。
    for (const toolCase of toolCases) {
      expect(controller.beforeToolCall({ toolName: toolCase.toolName, input: { path: toolCase.path } })).toBeUndefined()
    }
    expect(controller.shouldContinueAfterSettle()).toBe(true)

    const settle = controller.buildSettleContinuation([])
    expect(settle?.continue).toBe(true)
    const text = collectCustomMessageText(settle?.entries)
    for (const toolCase of toolCases) {
      expect(text).toContain(`${toolCase.directory} 规则`)
    }

    // 注入后收敛：pending 已清空，不再重复续跑，后续调用仍然放行。
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.buildSettleContinuation([])).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('read-dir', 'a.ts') } })).toBeUndefined()
  })

  test('Given 首次访问激活子目录指令 When 本轮 settle Then 以不可见 custom_message 注入并保留既有边界草稿', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })).toBeUndefined()

    const prior = { type: 'custom' as const, customType: 'prior-extension' }
    const settle = controller.buildSettleContinuation([prior])

    expect(settle?.continue).toBe(true)
    expect(settle?.entries?.[0]).toEqual(prior)
    expect(settle?.entries?.length).toBe(2)
    const draft = settle?.entries?.[1]
    expect(draft).toMatchObject({ type: 'custom_message', customType: 'proma-project-instruction', display: false })
    expect(collectCustomMessageText(settle?.entries)).toContain('子目录规则')

    // settle 已消费：后续 settle 与兜底注入都不再重复处理同一来源。
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.buildSettleContinuation([])).toBeUndefined()
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given 本轮未触发 settle When 下一次 before_agent_start 兜底 Then 注入指令且同一来源只注入一次', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })).toBeUndefined()

    const prompt = controller.appendPendingInstructions('基础系统提示词')
    expect(prompt).toContain('基础系统提示词')
    expect(prompt).toContain('## 已按访问路径激活的项目指令')
    expect(prompt).toContain('子目录规则')
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.appendPendingInstructions('基础系统提示词')).toBe('基础系统提示词')
  })

  test('Given 已注入的 AGENTS.md 内容改变 When 再次访问 Then 按新哈希重新入 pending 并再次注入', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    mkdirSync(join(projectRoot, 'sub'))
    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v1\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })).toBeUndefined()
    const firstSettle = controller.buildSettleContinuation([])
    expect(collectCustomMessageText(firstSettle?.entries)).toContain('子目录规则 v1')

    writeFileSync(join(projectRoot, 'sub', 'AGENTS.md'), '# 子目录规则 v2\n')
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: join('sub', 'a.ts') } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(true)
    const secondSettle = controller.buildSettleContinuation([])
    expect(secondSettle?.continue).toBe(true)
    expect(collectCustomMessageText(secondSettle?.entries)).toContain('子目录规则 v2')
    expect(controller.shouldContinueAfterSettle()).toBe(false)
  })

  test('Given 无指令文件的子目录或项目外目标 When 访问 Then 不注入也不续跑', () => {
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

    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.buildSettleContinuation([])).toBeUndefined()
  })

  test('Given 指令元数据解析失败 When 调用工具 Then 仍然放行且不安排续跑', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 根目录规则\n')
    const controller = createController(projectRoot)

    rmSync(projectRoot, { recursive: true, force: true })
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'a.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(false)
  })
})

describe('legacy CLAUDE.md 非阻断迁移', () => {
  test('Given 目录仅有 legacy CLAUDE.md When edit/write Then 放行且 settle 注入迁移建议', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    writeFileSync(join(projectRoot, 'second.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    // 首次 edit/write 直接放行，不阻断也不终止本轮。
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'second.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(true)

    const settle = controller.buildSettleContinuation([])
    expect(settle?.continue).toBe(true)
    const text = collectCustomMessageText(settle?.entries)
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('CLAUDE.md')

    // 同一来源只续跑一次；模型继续修改其他文件也不会再次触发续跑。
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.buildSettleContinuation([])).toBeUndefined()
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(false)
  })

  test('Given 目录仅有 legacy CLAUDE.md When 直接创建同目录 AGENTS.md Then 放行且不提示迁移', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    // 创建 AGENTS.md 本身就是迁移动作；此时磁盘上尚无 AGENTS.md，解析仍返回 legacy 来源。
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'AGENTS.md' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(false)

    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 新建 AGENTS.md\n')
    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(true)
    const settle = controller.buildSettleContinuation([])
    expect(collectCustomMessageText(settle?.entries)).toContain('新建 AGENTS.md')
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.beforeToolCall({ toolName: 'write', input: { path: 'other.ts' } })).toBeUndefined()
  })

  test('Given legacy 迁移建议已注入 When legacy 内容改变 Then 防御守卫不重置，只按新哈希激活指令', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则 v1\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    const firstSettle = controller.buildSettleContinuation([])
    expect(collectCustomMessageText(firstSettle?.entries)).toContain('AGENTS.md')
    expect(controller.shouldContinueAfterSettle()).toBe(false)

    // 内容变化产生新哈希，作为普通指令重新入 pending 并再注入一次；
    // 但 legacy 迁移续跑守卫已消费，不会额外获得第二次迁移续跑。
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则 v2\n')
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(true)
    const secondSettle = controller.buildSettleContinuation([])
    expect(collectCustomMessageText(secondSettle?.entries)).toContain('legacy 规则 v2')

    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.beforeToolCall({ toolName: 'edit', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(false)
  })

  test('Given legacy 目录只做只读访问 When read Then 不提示迁移也不续跑', () => {
    const projectRoot = createProject()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# legacy 规则\n')
    writeFileSync(join(projectRoot, 'other.ts'), 'export {}\n')
    const controller = createController(projectRoot)

    expect(controller.beforeToolCall({ toolName: 'read', input: { path: 'other.ts' } })).toBeUndefined()
    expect(controller.shouldContinueAfterSettle()).toBe(false)
    expect(controller.buildSettleContinuation([])).toBeUndefined()
  })
})
