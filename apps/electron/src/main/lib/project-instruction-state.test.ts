import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMemoryFiles } from './project-memory-scaffold'
import { setMemoryRootsForTesting } from './memory-service'
import {
  instructionRecordPath,
  readInstructionReadyRecord,
  writeInstructionReadyRecord,
  type ProjectInstructionContext,
} from './project-instruction-state'

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-instruction-state-'))
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

/** 准备一份可记录完成的现场：项目 AGENTS.md 与两份记忆都非空。 */
function prepareReadyFiles(): string {
  const target = join(projectRoot, 'AGENTS.md')
  writeFileSync(target, '# 项目约定\n\n- 使用 Bun 运行测试\n', 'utf8')
  ensureMemoryFiles({ projectRoot, workspaceSlug: 'default' })
  return target
}

describe('项目能力维护记录', () => {
  test('Given 规则与记忆就绪 When 写入记录 Then 可按项目根读回', () => {
    const target = prepareReadyFiles()

    const record = writeInstructionReadyRecord(makeCtx(), target, true)

    expect(record.version).toBe(1)
    expect(record.changed).toBe(true)
    const read = readInstructionReadyRecord(makeCtx())
    expect(read?.targetPath).toBe(target)
    expect(read?.completedAt).toBe(record.completedAt)
  })

  test('Given 记录存在 When 再次写入且无变化 Then 复用原完成时间', () => {
    const target = prepareReadyFiles()
    const first = writeInstructionReadyRecord(makeCtx(), target, true)

    const second = writeInstructionReadyRecord(makeCtx(), target, false)

    expect(second.completedAt).toBe(first.completedAt)
  })

  test('Given 规则文件被外部修改 When 读取记录 Then 标记失效', () => {
    const target = prepareReadyFiles()
    writeInstructionReadyRecord(makeCtx(), target, true)

    writeFileSync(target, '# 项目约定\n\n- 已改动的规则\n', 'utf8')

    expect(readInstructionReadyRecord(makeCtx())).toBeUndefined()
  })

  test('Given 旧外层规则重新出现 When 读取记录 Then 标记失效', () => {
    const target = prepareReadyFiles()
    writeInstructionReadyRecord(makeCtx(), target, true)

    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    expect(readInstructionReadyRecord(makeCtx())).toBeUndefined()
  })

  test('Given 项目索引为空 When 写入记录 Then 拒绝记录', () => {
    const target = join(projectRoot, 'AGENTS.md')
    writeFileSync(target, '# 项目约定\n', 'utf8')
    const paths = ensureMemoryFiles({ projectRoot, workspaceSlug: 'default' })
    writeFileSync(paths.index, '', 'utf8')

    expect(() => writeInstructionReadyRecord(makeCtx(), target, true)).toThrow('尚未就绪')
  })

  test('Given 规则文件缺失 When 写入记录 Then 拒绝记录', () => {
    ensureMemoryFiles({ projectRoot, workspaceSlug: 'default' })

    expect(() => writeInstructionReadyRecord(makeCtx(), join(projectRoot, 'AGENTS.md'), true)).toThrow('尚未就绪')
  })

  test('Given 不同项目根 When 计算记录路径 Then 互不覆盖', () => {
    const other = join(root, 'other-project')
    mkdirSync(other, { recursive: true })

    expect(instructionRecordPath(makeCtx())).not.toBe(instructionRecordPath(makeCtx({ projectRoot: other })))
  })

  test('Given 工作区根就是项目根 When 记录完成 Then 不把项目规则当旧规则失效', () => {
    const sharedCtx = makeCtx({ workspaceRoot: projectRoot })
    const target = prepareReadyFiles()

    writeInstructionReadyRecord(sharedCtx, target, true)

    expect(readInstructionReadyRecord(sharedCtx)?.targetPath).toBe(target)
  })

  test('Given 记录文件损坏 When 读取 Then 视为未完成', () => {
    const target = prepareReadyFiles()
    const path = instructionRecordPath(makeCtx())
    mkdirSync(join(workspaceRoot, 'instruction-maintenance'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf8')

    expect(readInstructionReadyRecord(makeCtx())).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(target).toBeTruthy()
  })
})
