import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setMemoryRootsForTesting } from './memory-service'
import {
  MAX_INSTRUCTION_BYTES,
  inspectInstructionMigration,
  inspectLegacyProjectInstructions,
  instructionInspectionRevision,
  pendingInstructionMigrations,
  projectInstructionsPath,
  readInstructionFile,
} from './project-instruction-inspect'
import type { ProjectInstructionContext } from './project-instruction-state'

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-instruction-inspect-'))
  projectRoot = join(root, 'project')
  workspaceRoot = join(root, 'workspace')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  setMemoryRootsForTesting({
    globalMemoryDir: join(root, 'global-memory'),
    projectMemoryDir: () => join(root, 'workspace-memory'),
  })
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

function makeCtx(overrides: Partial<ProjectInstructionContext> = {}): ProjectInstructionContext {
  return {
    projectRoot,
    canonicalProjectRoot: projectRoot,
    workspaceSlug: 'default',
    workspaceRoot,
    ...overrides,
  }
}

describe('项目规则检查', () => {
  test('Given 项目规则缺失 When 检查 Then 目标为空且不要求迁移', () => {
    const state = inspectInstructionMigration(makeCtx())

    expect(state.target.path).toBe(join(projectRoot, 'AGENTS.md'))
    expect(state.target.content).toBeNull()
    expect(state.sources).toEqual([])
    expect(state.needed).toBe(false)
    expect(state.deferred).toBe(false)
  })

  test('Given 只有旧外层规则 When 检查 Then 要求迁移并给出内容', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 旧命令\n', 'utf8')

    const state = inspectInstructionMigration(makeCtx())

    expect(state.sources).toHaveLength(1)
    expect(state.sources[0]?.path).toBe(join(workspaceRoot, 'AGENTS.md'))
    expect(state.sources[0]?.content).toContain('旧命令')
    expect(state.needed).toBe(true)
  })

  test('Given 工作区根就是项目根 When 检查 Then 不把项目规则算作旧来源', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n', 'utf8')

    const state = inspectInstructionMigration(makeCtx({ workspaceRoot: projectRoot }))

    expect(state.sources).toEqual([])
    expect(state.needed).toBe(false)
  })

  test('Given 旧来源是符号链接 When 检查 Then 报不可安全修改', () => {
    const real = join(root, 'real-agents.md')
    writeFileSync(real, '# 真实规则\n', 'utf8')
    symlinkSync(real, join(workspaceRoot, 'AGENTS.md'))

    const state = inspectInstructionMigration(makeCtx())

    expect(state.issues).toHaveLength(1)
    expect(state.issues[0]?.message).toContain('符号链接')
    expect(state.sources).toEqual([])
    expect(state.needed).toBe(true)
  })

  test('Given 旧来源超过 512 KiB When 检查 Then 报不可安全修改', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), 'a'.repeat(MAX_INSTRUCTION_BYTES + 1), 'utf8')

    const state = inspectInstructionMigration(makeCtx())

    expect(state.issues[0]?.message).toContain('512 KiB')
  })

  test('Given 会话在 worktree When 检查 Then 报告需延后', () => {
    const worktree = join(root, 'project-wt')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    const state = inspectInstructionMigration(makeCtx({
      projectRoot: worktree,
      canonicalProjectRoot: projectRoot,
      isWorktree: true,
    }))

    expect(state.deferred).toBe(true)
    expect(state.target.path).toBe(join(worktree, 'AGENTS.md'))
  })

  test('Given 未完成迁移记录 When 检查 Then 列出 pending ID', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    mkdirSync(join(workspaceRoot, 'instruction-history'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'instruction-history', `${id}.json`), JSON.stringify({
      version: 1,
      id,
      projectRoot,
      target: { path: join(projectRoot, 'AGENTS.md'), content: null, revision: '' },
      sources: [{ path: join(workspaceRoot, 'AGENTS.md'), content: '# 旧\n', revision: 'x' }],
      content: '# 合并\n',
      summary: '示例',
      status: 'pending',
      createdAt: Date.now(),
    }), 'utf8')

    expect(pendingInstructionMigrations(makeCtx())).toEqual([id])
    expect(inspectInstructionMigration(makeCtx()).needed).toBe(true)
  })

  test('Given 规则正文变化 When 计算检查版本 Then 版本随之变化', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')
    const before = instructionInspectionRevision(makeCtx())

    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 新增\n', 'utf8')

    expect(instructionInspectionRevision(makeCtx())).not.toBe(before)
  })

  test('Given 目标目录是文件夹 When 读取规则 Then 抛错而不当成缺失', () => {
    mkdirSync(join(projectRoot, 'AGENTS.md'))

    expect(() => readInstructionFile(join(projectRoot, 'AGENTS.md'))).toThrow('不是普通文件')
  })

  test('Given 只有 AGENTS.MD When 定位项目规则 Then 返回可读的规则文件', () => {
    writeFileSync(join(projectRoot, 'AGENTS.MD'), '# 项目约定\n', 'utf8')

    const path = projectInstructionsPath(projectRoot)

    // 大小写不敏感的文件系统上 `AGENTS.md` 与 `AGENTS.MD` 指向同一个文件。
    expect(path.toLowerCase()).toBe(join(projectRoot, 'AGENTS.md').toLowerCase())
    expect(readFileSync(path, 'utf8')).toContain('项目约定')
  })

  test('Given 旧规则只含 AGENTS.MD When 检查 Then 作为单一来源', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.MD'), '# 旧外层规则\n', 'utf8')

    const { sources, issues } = inspectLegacyProjectInstructions(makeCtx())

    expect(issues).toEqual([])
    expect(sources).toHaveLength(1)
    expect(sources[0]?.content).toContain('旧外层规则')
  })
})
