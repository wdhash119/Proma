import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setMemoryRootsForTesting } from './memory-service'
import { inspectInstructionMigration } from './project-instruction-inspect'
import {
  mergeProjectInstructions,
  replanProjectInstructions,
  resumeProjectInstructions,
} from './project-instruction-migration'
import { instructionPathKey, type ProjectInstructionContext } from './project-instruction-state'

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-instruction-migration-'))
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

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 写入一份待迁移的旧外层规则，并返回可以直接提交的提案骨架。 */
function prepareLegacySource(content = '# 旧外层规则\n\n- 旧命令\n'): { targetRevision: string; sources: Array<{ path: string; revision: string }> } {
  writeFileSync(join(workspaceRoot, 'AGENTS.md'), content, 'utf8')
  const state = inspectInstructionMigration(makeCtx())
  return {
    targetRevision: state.target.revision,
    sources: state.sources.map((source) => ({ path: source.path, revision: source.revision })),
  }
}

/** 直接落一份未完成迁移记录，用于恢复与重规划场景。 */
function writePendingJournal(id: string, sourceContent: string): void {
  mkdirSync(join(workspaceRoot, 'instruction-history'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'instruction-history', `${id}.json`), JSON.stringify({
    version: 1,
    id,
    projectRoot: instructionPathKey(projectRoot),
    target: { path: join(projectRoot, 'AGENTS.md'), content: null, revision: hash('') },
    sources: [{ path: join(workspaceRoot, 'AGENTS.md'), content: sourceContent, revision: hash(sourceContent) }],
    content: '# 合并后的规则\n',
    summary: '去重保留旧命令',
    status: 'pending',
    createdAt: Date.now(),
  }), 'utf8')
}

describe('项目规则迁移', () => {
  test('Given 检查通过 When 提交合并 Then 写入目标并移动旧文件到归档', () => {
    const base = prepareLegacySource()

    const id = mergeProjectInstructions(makeCtx(), {
      ...base,
      content: '# 项目约定\n\n- 旧命令\n',
      summary: '保留旧命令',
    })

    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toBe('# 项目约定\n\n- 旧命令\n')
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(false)
    const archives = readdirSync(join(workspaceRoot, 'instruction-archive'))
    expect(archives).toHaveLength(1)
    expect(readFileSync(join(workspaceRoot, 'instruction-archive', archives[0]!, 'AGENTS.md'), 'utf8')).toContain('旧命令')
    const journal = JSON.parse(readFileSync(join(workspaceRoot, 'instruction-history', `${id}.json`), 'utf8')) as { status: string; summary: string }
    expect(journal.status).toBe('completed')
    expect(journal.summary).toBe('保留旧命令')
  })

  test('Given 目标在检查后被改动 When 提交合并 Then 要求重新检查', () => {
    const base = prepareLegacySource()
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 用户新写的规则\n', 'utf8')

    expect(() => mergeProjectInstructions(makeCtx(), {
      ...base,
      content: '# 合并\n',
      summary: '合并',
    })).toThrow('请重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并')
  })

  test('Given 旧来源在检查后被改动 When 提交合并 Then 拒绝提交并保留旧文件', () => {
    const base = prepareLegacySource()
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 用户新增\n', 'utf8')

    expect(() => mergeProjectInstructions(makeCtx(), {
      ...base,
      content: '# 合并\n',
      summary: '合并',
    })).toThrow('请重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并')
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(true)
  })

  test('Given 存在旧 CLAUDE.md When 创建项目规则 Then 保留其入口', () => {
    const base = prepareLegacySource()
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# Claude 规则\n', 'utf8')

    mergeProjectInstructions(makeCtx(), { ...base, content: '# 项目约定\n', summary: '合并' })

    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toContain('](./CLAUDE.md)')
  })

  test('Given 会话在 worktree When 提交合并 Then 拒绝改写原 checkout', () => {
    const worktree = join(root, 'project-wt')
    mkdirSync(worktree, { recursive: true })
    const base = prepareLegacySource()

    expect(() => mergeProjectInstructions(makeCtx({
      projectRoot: worktree,
      canonicalProjectRoot: projectRoot,
      isWorktree: true,
    }), { ...base, content: '# 合并\n', summary: '合并' })).toThrow('不能从 worktree 改写其他 checkout')
  })

  test('Given 只读会话 When 提交合并 Then 拒绝一切写操作', () => {
    const base = prepareLegacySource()

    expect(() => mergeProjectInstructions(makeCtx({ allowInstructionMaintenance: false }), {
      ...base,
      content: '# 合并\n',
      summary: '合并',
    })).toThrow('当前只读、计划或无人值守会话不执行项目能力维护。')
  })

  test('Given 已完成迁移 When 再次恢复 Then 幂等返回同一 ID', () => {
    const base = prepareLegacySource()
    const id = mergeProjectInstructions(makeCtx(), { ...base, content: '# 项目约定\n', summary: '合并' })

    expect(resumeProjectInstructions(makeCtx(), id)).toBe(id)
  })

  test('Given 旧来源在迁移记录之后被外部编辑 When 恢复 Then 保留文件并报错', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    writePendingJournal(id, '# 旧外层规则\n')
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 用户新增\n', 'utf8')

    expect(() => resumeProjectInstructions(makeCtx(), id)).toThrow('保留原文等待重新核对')
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(projectRoot, 'AGENTS.md'))).toBe(false)
  })

  test('Given 旧来源已缺失 When 重规划 Then 从快照恢复并退役旧计划', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    writePendingJournal(id, '# 旧外层规则\n')

    expect(replanProjectInstructions(makeCtx(), id)).toBe(id)
    expect(readFileSync(join(workspaceRoot, 'AGENTS.md'), 'utf8')).toBe('# 旧外层规则\n')
    const journal = JSON.parse(readFileSync(join(workspaceRoot, 'instruction-history', `${id}.json`), 'utf8')) as { status: string }
    expect(journal.status).toBe('superseded')
    expect(() => resumeProjectInstructions(makeCtx(), id)).toThrow('已退役')
  })

  test('Given 重规划后再次重规划 When 调用 Then 幂等返回', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    writePendingJournal(id, '# 旧外层规则\n')
    replanProjectInstructions(makeCtx(), id)

    expect(replanProjectInstructions(makeCtx(), id)).toBe(id)
  })

  test('Given 无效迁移 ID When 恢复 Then 报 ID 无效', () => {
    expect(() => resumeProjectInstructions(makeCtx(), '../../etc/passwd')).toThrow('迁移 ID 无效')
  })

  test('Given 没有待合并来源 When 提交合并 Then 报错且不写文件', () => {
    expect(() => mergeProjectInstructions(makeCtx(), {
      targetRevision: hash(''),
      sources: [],
      content: '# 合并\n',
      summary: '合并',
    })).toThrow('没有待合并的外层 AGENTS.md')
  })
})
