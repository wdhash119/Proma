import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as memoryService from './memory-service'

const workspaceSlug = 'demo-workspace'
const root = mkdtempSync(join(tmpdir(), 'proma-memory-'))
const globalMemoryDir = join(root, 'global')
const projectMemoryRoot = join(root, 'workspaces')

function projectDir(): string {
  return join(projectMemoryRoot, workspaceSlug, 'memory')
}

function seedProjectMemory(): void {
  const dir = projectDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n', 'utf8')
  writeFileSync(join(dir, 'deploy.md'), '# 部署\n\n- 使用 Bun 构建\n- 发布产物在 dist\n', 'utf8')
}

beforeEach(() => {
  rmSync(globalMemoryDir, { recursive: true, force: true })
  rmSync(projectMemoryRoot, { recursive: true, force: true })
  memoryService.setMemoryRootsForTesting({
    globalMemoryDir,
    projectMemoryDir: (slug) => join(projectMemoryRoot, slug, 'memory'),
  })
  mkdirSync(globalMemoryDir, { recursive: true })
  seedProjectMemory()
})

afterAll(() => {
  memoryService.setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('单条事实维护', () => {
  test('Given 已有一条事实 When add Then 只追加这一条，其他内容不变', () => {
    const content = '# 部署\n\n- 使用 Bun 构建\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'add', entry: '- 发布产物在 dist' },
    ])

    expect(next).toBe('# 部署\n\n- 使用 Bun 构建\n- 发布产物在 dist\n')
  })

  test('Given 指定 after When add Then 插入到锚点之后', () => {
    const content = '- 甲\n- 乙\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'add', entry: '- 丙', after: '- 甲' },
    ])

    expect(next).toBe('- 甲\n- 丙\n- 乙\n')
  })

  test('Given 命中唯一事实 When update Then 原地替换且不触碰其他行', () => {
    const content = '# 标题\n\n- 旧结论\n- 无关\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'update', match: '- 旧结论', entry: '- 新结论' },
    ])

    expect(next).toBe('# 标题\n\n- 新结论\n- 无关\n')
  })

  test('Given 命中唯一事实 When remove Then 删除该行', () => {
    const content = '- 甲\n- 乙\n'

    const next = memoryService.applyMemoryOperations(content, [
      { op: 'remove', match: '- 甲' },
    ])

    expect(next).toBe('- 乙\n')
  })

  test('Given 匹配文本命中多行 When remove Then 报错并保留原文', () => {
    const content = '- 甲\n- 甲\n'

    expect(() => memoryService.applyMemoryOperations(content, [
      { op: 'remove', match: '- 甲' },
    ])).toThrow('匹配到多条相同条目')
  })

  test('Given 条目缺少列表前缀 When add Then 拒绝写入', () => {
    expect(() => memoryService.applyMemoryOperations('- 甲\n', [
      { op: 'add', entry: '乙' },
    ])).toThrow('必须是以 "- " 开头')
  })
})

describe('写入与版本历史', () => {
  test('Given 全局画像 When 首次写入 Then 建立文件并返回新 revision', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    expect(initial.content).toBe('')

    const result = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '新增个人画像事实',
      content: '# 全局用户画像\n\n- 用户是教师\n',
    })

    const stored = readFileSync(initial.path, 'utf8')
    expect(stored).toContain('用户是教师')
    expect(result.chars).toBeGreaterThan(0)
  })

  test('Given revision 已过期 When 写入 Then 拒绝覆盖并提示重新读取', () => {
    const initial = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '第一次写入',
      content: '- 事实一\n',
    })

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: initial.revision,
      summary: '并发写入',
      content: '- 事实二\n',
    })).toThrow('记忆已被修改')
  })

  test('Given 覆盖已有内容 When 写入 Then 生成可恢复的历史快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const created = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立画像',
      content: '- 事实一\n',
    })

    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: current.revision,
      summary: '追加事实二',
      operations: [{ op: 'add', entry: '- 事实二' }],
    })

    const history = memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)
    expect(history.length).toBe(1)
    expect(history[0]?.summary).toBe('追加事实二')
    // 首版写入时旧内容为空，因此历史里只保留被 operations 覆盖掉的那一版。
    expect(created.chars).toBeGreaterThan(0)
  })

  test('Given 存在历史版本 When 恢复 Then 正文回到旧版本且当前内容另存快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '第一版',
      content: '- 事实一\n',
    })
    const second = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: second.revision,
      summary: '第二版',
      content: '- 事实一\n- 事实二\n',
    })

    const history = memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)
    const restoreTarget = history[0]!
    memoryService.restoreMemoryRevision(memoryService.GLOBAL_PROFILE_TARGET, restoreTarget.id)

    const restored = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    expect(restored.content).toBe('- 事实一\n')
    // 恢复本身也可回退：历史里新增一条自动快照。
    expect(memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET).length).toBe(2)
  })

  test('Given 内容未变化 When 写入 Then 不产生历史快照', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立',
      content: '- 事实一\n',
    })
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const result = memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: current.revision,
      summary: '重复写入',
      content: '- 事实一\n',
    })

    expect(result.snapshotId).toBeUndefined()
    // 两次写入内容完全相同，全程没有产生任何历史快照。
    expect(memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)).toEqual([])
  })
})

describe('跨层检索', () => {
  test('Given 全局与项目记忆都有相关内容 When 检索 Then 两层都能命中并带行号', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '建立画像',
      content: '# 全局用户画像\n\n- 用户使用 Bun 构建\n',
    })

    const hits = memoryService.searchMemory('Bun 构建', workspaceSlug)
    const sources = hits.map((hit) => hit.source)

    expect(sources).toContain('全局画像')
    expect(sources).toContain('项目记忆/deploy.md')
    expect(hits.every((hit) => hit.line > 0)).toBe(true)
  })

  test('Given 空查询 When 检索 Then 不返回任何片段', () => {
    expect(memoryService.searchMemory('   ', workspaceSlug)).toEqual([])
  })
})
