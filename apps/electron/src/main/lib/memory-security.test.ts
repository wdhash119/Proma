import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as memoryService from './memory-service'

const workspaceSlug = 'secure-workspace'
const root = mkdtempSync(join(tmpdir(), 'proma-memory-security-'))
const globalMemoryDir = join(root, 'global')
const projectMemoryRoot = join(root, 'workspaces')

function projectDir(): string {
  return join(projectMemoryRoot, workspaceSlug, 'memory')
}

function revisionsDir(): string {
  return join(globalMemoryDir, '.revisions')
}

/** 直接落一份快照 JSON；用于构造上限/绑定类边界，不走正常写入。 */
function writeSnapshot(id: string, payload: Record<string, unknown>): void {
  mkdirSync(revisionsDir(), { recursive: true })
  writeFileSync(join(revisionsDir(), `${id}.json`), JSON.stringify(payload, null, 2), 'utf8')
}

beforeEach(() => {
  rmSync(globalMemoryDir, { recursive: true, force: true })
  rmSync(projectMemoryRoot, { recursive: true, force: true })
  memoryService.setMemoryRootsForTesting({
    globalMemoryDir,
    projectMemoryDir: (slug) => join(projectMemoryRoot, slug, 'memory'),
  })
  mkdirSync(globalMemoryDir, { recursive: true })
  mkdirSync(projectDir(), { recursive: true })
  writeFileSync(join(projectDir(), 'MEMORY.md'), '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n', 'utf8')
  writeFileSync(join(projectDir(), 'deploy.md'), '# 部署\n\n- 使用 Bun 构建\n', 'utf8')
})

afterAll(() => {
  memoryService.setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('写入字节上限', () => {
  test('Given 513KiB 正文 When MemoryUpdate 写入 Then 拒绝且文件不变', () => {
    const doc = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: doc.revision,
      summary: '超大正文',
      content: 'x'.repeat(513 * 1024),
    })).toThrow('512 KiB')
    expect(existsSync(doc.path)).toBe(false)
  })

  test('Given 513KiB 历史快照 When 恢复 Then 拒绝且当前正文不变', () => {
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    writeSnapshot('global-profile__1700000000000__deadbeef', {
      id: 'global-profile__1700000000000__deadbeef',
      target: memoryService.GLOBAL_PROFILE_TARGET,
      createdAt: 1700000000000,
      summary: '超大历史',
      chars: 513 * 1024,
      content: 'x'.repeat(513 * 1024),
    })

    expect(() => memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      'global-profile__1700000000000__deadbeef',
      current.revision,
    )).toThrow('512 KiB')
    expect(existsSync(current.path)).toBe(false)
  })
})

describe('全局画像预算', () => {
  test('Given 101 条事实 When MemoryUpdate 写入 Then 拒绝', () => {
    const doc = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const content = Array.from({ length: 101 }, (_item, index) => `- 事实 ${index}`).join('\n') + '\n'

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: doc.revision,
      summary: '超条数',
      content,
    })).toThrow('超预算')
  })

  test('Given 5001 码元 When MemoryUpdate 写入 Then 拒绝', () => {
    const doc = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const content = `- ${'x'.repeat(memoryService.PROFILE_MAX_CHARS - 1)}\n`

    expect(() => memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: doc.revision,
      summary: '超码元',
      content,
    })).toThrow('超预算')
  })

  test('Given 超预算历史快照 When 恢复 Then 拒绝', () => {
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    const overChars = '- ' + 'x'.repeat(memoryService.PROFILE_MAX_CHARS) + '\n'
    writeSnapshot('global-profile__1700000000001__deadbeef', {
      id: 'global-profile__1700000000001__deadbeef',
      target: memoryService.GLOBAL_PROFILE_TARGET,
      createdAt: 1700000000001,
      summary: '超预算历史',
      chars: overChars.length,
      content: overChars,
    })

    expect(() => memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      'global-profile__1700000000001__deadbeef',
      current.revision,
    )).toThrow('超预算')
  })
})

describe('历史 ID 与目标绑定', () => {
  test('Given 路径穿越 ID When 读取或恢复 Then 均拒绝', () => {
    const outsidePath = join(globalMemoryDir, '..', 'outside.json')
    writeFileSync(outsidePath, JSON.stringify({ content: '外部内容' }), 'utf8')
    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)

    expect(memoryService.readMemoryRevision(memoryService.GLOBAL_PROFILE_TARGET, '../outside')).toBeNull()
    expect(() => memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      '../outside',
      current.revision,
    )).toThrow('非法的历史版本 ID')
    expect(memoryService.isValidMemoryRevisionId(memoryService.GLOBAL_PROFILE_TARGET, '../outside')).toBe(false)
  })

  test('Given 其他目标的历史 ID When 读取或恢复 Then 均拒绝', () => {
    const deploy = memoryService.readMemoryDocument('deploy.md', workspaceSlug)
    const updated = memoryService.updateMemory({
      target: 'deploy.md',
      revision: deploy.revision,
      summary: '更新部署记忆',
      content: '# 部署\n\n- 使用 Bun 构建\n- 产物在 dist\n',
    }, workspaceSlug)
    expect(updated.snapshotId).toBeDefined()

    const index = memoryService.readMemoryDocument('MEMORY.md', workspaceSlug)
    expect(memoryService.readMemoryRevision('MEMORY.md', updated.snapshotId!, workspaceSlug)).toBeNull()
    expect(() => memoryService.restoreMemoryRevision(
      'MEMORY.md',
      updated.snapshotId!,
      index.revision,
      workspaceSlug,
    )).toThrow('非法的历史版本 ID')
    // 原目标下仍可正常读取。
    expect(memoryService.readMemoryRevision('deploy.md', updated.snapshotId!, workspaceSlug)?.id)
      .toBe(updated.snapshotId!)
  })

  test('Given 快照 target 与请求不符 When 读取 Then 拒绝', () => {
    const forgedId = 'global-profile__1700000000002__deadbeef'
    writeSnapshot(forgedId, {
      id: forgedId,
      target: 'MEMORY.md',
      createdAt: 1700000000002,
      summary: '伪造目标',
      chars: 2,
      content: '- x\n',
    })

    expect(memoryService.readMemoryRevision(memoryService.GLOBAL_PROFILE_TARGET, forgedId)).toBeNull()
  })

  test('Given 快照 JSON 非法 When 读取 Then 返回 null 而不是抛错', () => {
    mkdirSync(revisionsDir(), { recursive: true })
    writeFileSync(join(revisionsDir(), 'global-profile__1700000000003__deadbeef.json'), '{not-json', 'utf8')

    expect(memoryService.readMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      'global-profile__1700000000003__deadbeef',
    )).toBeNull()
  })
})

describe('恢复并发冲突', () => {
  test('Given 读取后又发生并发编辑 When 按旧 revision 恢复 Then 拒绝覆盖', () => {
    const first = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: first.revision,
      summary: '第一版',
      content: '- 事实零\n',
    })
    const second = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: second.revision,
      summary: '第二版',
      content: '- 事实一\n',
    })
    const history = memoryService.listMemoryHistory(memoryService.GLOBAL_PROFILE_TARGET)
    const restoreTarget = history[0]!

    // 模拟设置页还停留在旧 revision 时，Agent 又写了新内容。
    const stale = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.updateMemory({
      target: memoryService.GLOBAL_PROFILE_TARGET,
      revision: stale.revision,
      summary: '并发编辑',
      content: '- 事实一\n- 事实二\n',
    })

    expect(() => memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      restoreTarget.id,
      stale.revision,
    )).toThrow('记忆已被修改')
    expect(memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET).content)
      .toBe('- 事实一\n- 事实二\n')

    const current = memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET)
    memoryService.restoreMemoryRevision(
      memoryService.GLOBAL_PROFILE_TARGET,
      restoreTarget.id,
      current.revision,
    )
    expect(memoryService.readMemoryDocument(memoryService.GLOBAL_PROFILE_TARGET).content).toBe('- 事实零\n')
  })
})
