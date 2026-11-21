import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setMemoryRootsForTesting } from './memory-service'
import { hasMemoryAssociation, resetMemoryWriteLocksForTesting } from './project-memory-scaffold'
import {
  finishInstructionMaintenance,
  instructionMaintenancePrompt,
  maintainProjectInstructions,
} from './project-instruction-maintenance'
import { readInstructionReadyRecord, type ProjectInstructionContext } from './project-instruction-state'

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-instruction-maintain-'))
  projectRoot = join(root, 'project')
  workspaceRoot = join(root, 'workspace')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  setMemoryRootsForTesting({
    globalMemoryDir: join(root, 'global-memory'),
    projectMemoryDir: () => join(root, 'workspace-memory'),
  })
  resetMemoryWriteLocksForTesting()
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  resetMemoryWriteLocksForTesting()
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

describe('项目能力维护', () => {
  test('Given 只有旧外层规则 When 维护 Then 自动迁移并记录完成', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 旧命令\n', 'utf8')

    const result = maintainProjectInstructions(makeCtx())

    expect(result.status).toBe('ready')
    expect(result.changed).toBe(true)
    const target = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(target).toContain('旧命令')
    expect(hasMemoryAssociation({ projectRoot, workspaceSlug: 'default' }, target)).toBe(true)
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(false)
    expect(readInstructionReadyRecord(makeCtx())?.targetPath).toBe(join(projectRoot, 'AGENTS.md'))
  })

  test('Given 已完成维护 When 再次维护 Then 直接返回 ready 且无变化', () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')
    maintainProjectInstructions(makeCtx())

    const again = maintainProjectInstructions(makeCtx())

    expect(again.status).toBe('ready')
    expect(again.changed).toBe(false)
  })

  test('Given 项目没有任何规则 When 维护 Then 建立基础说明与记忆关联', () => {
    const result = maintainProjectInstructions(makeCtx())

    expect(result.status).toBe('ready')
    const target = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(target).toContain('# 项目约定')
    expect(hasMemoryAssociation({ projectRoot, workspaceSlug: 'default' }, target)).toBe(true)
  })

  test('Given 两侧存在不同正文 When 维护 Then 返回 needs-merge 且不写目标', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 项目侧规则\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 旧命令\n', 'utf8')

    const result = maintainProjectInstructions(makeCtx())

    expect(result.status).toBe('needs-merge')
    expect(result.sources).toHaveLength(1)
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toContain('项目侧规则')
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(true)
  })

  test('Given 旧来源不可安全读取 When 维护 Then 返回 blocked', () => {
    const real = join(root, 'real-agents.md')
    writeFileSync(real, '# 真实规则\n', 'utf8')
    symlinkSync(real, join(workspaceRoot, 'AGENTS.md'))

    const result = maintainProjectInstructions(makeCtx())

    expect(result.status).toBe('blocked')
    expect(result.issues?.[0]?.message).toContain('符号链接')
  })

  test('Given 会话在 worktree 且有旧规则 When 维护 Then 报告需延后', () => {
    const worktree = join(root, 'project-wt')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    const result = maintainProjectInstructions(makeCtx({
      projectRoot: worktree,
      canonicalProjectRoot: projectRoot,
      isWorktree: true,
    }))

    expect(result.status).toBe('deferred')
    expect(existsSync(join(worktree, 'AGENTS.md'))).toBe(false)
  })

  test('Given 只读会话 When 维护 Then 拒绝写入', () => {
    expect(() => maintainProjectInstructions(makeCtx({ allowInstructionMaintenance: false })))
      .toThrow('当前只读、计划或无人值守会话不执行项目能力维护。')
  })

  test('Given 仍有待合并来源 When 结束维护 Then 拒绝记录完成', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    expect(() => finishInstructionMaintenance(makeCtx())).toThrow('旧项目规则尚未合并')
  })
})

describe('首次能力维护提示', () => {
  test('Given 尚未维护 When 生成提示 Then 要求直接调用维护工具', () => {
    const prompt = instructionMaintenancePrompt(makeCtx())

    expect(prompt).toContain('## 首次项目能力维护')
    expect(prompt).toContain('ProjectInstructionsMaintain')
    expect(prompt).toContain('这次也顺手完善了项目的 Agent 协作能力')
  })

  test('Given 已完成维护 When 生成提示 Then 不再注入', () => {
    maintainProjectInstructions(makeCtx())

    expect(instructionMaintenancePrompt(makeCtx())).toBeUndefined()
  })

  test('Given 只读会话 When 生成提示 Then 不注入', () => {
    expect(instructionMaintenancePrompt(makeCtx({ allowProfileMigration: false }))).toBeUndefined()
  })

  test('Given 旧规则不可安全读取 When 生成提示 Then 不注入催促', () => {
    const real = join(root, 'real-agents.md')
    writeFileSync(real, '# 真实规则\n', 'utf8')
    symlinkSync(real, join(workspaceRoot, 'AGENTS.md'))

    expect(instructionMaintenancePrompt(makeCtx())).toBeUndefined()
  })
})
