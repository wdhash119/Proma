import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryError,
  archiveMemoryTheme,
  readMemoryDocument,
  setMemoryRootsForTesting,
} from './memory-service'

const workspaceSlug = 'demo'
let root: string

function memoryDir(): string {
  return join(root, 'workspaces', workspaceSlug, 'memory')
}

function seed(): void {
  const dir = memoryDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n- [排障](troubleshoot.md) — 常见故障\n', 'utf8')
  writeFileSync(join(dir, 'deploy.md'), '# 部署\n\n- 使用 Bun 构建\n', 'utf8')
  writeFileSync(join(dir, 'troubleshoot.md'), '# 排障\n\n- 先看日志\n', 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-memory-archive-'))
  setMemoryRootsForTesting({
    globalMemoryDir: join(root, 'global-memory'),
    projectMemoryDir: (slug) => join(root, 'workspaces', slug, 'memory'),
  })
  mkdirSync(join(root, 'global-memory'), { recursive: true })
  seed()
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

/** 归档后的时间戳目录里应恰好放着一个同名主题文件。 */
function archiveCopies(): string[] {
  const archiveRoot = join(memoryDir(), '.archive')
  if (!existsSync(archiveRoot)) return []
  return readdirSync(archiveRoot).flatMap((stamp) => readdirSync(join(archiveRoot, stamp)))
}

describe('归档记忆主题', () => {
  test('Given 主题已过期 When 归档 Then 正文移动到 .archive 且索引移除该入口', () => {
    const theme = readMemoryDocument('deploy.md', workspaceSlug)
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)
    const nextIndex = '# 项目记忆索引\n\n- [排障](troubleshoot.md) — 常见故障\n'

    const result = archiveMemoryTheme(workspaceSlug, 'deploy.md', theme.revision, index.revision, nextIndex)

    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(false)
    expect(readFileSync(result.archivedTo, 'utf8')).toBe('# 部署\n\n- 使用 Bun 构建\n')
    expect(result.archivedTo).toContain(join('.archive'))
    expect(result.archivedTo.endsWith('deploy.md')).toBe(true)
    expect(readFileSync(join(memoryDir(), 'MEMORY.md'), 'utf8')).toBe(nextIndex)
    expect(result.indexRevision).toBe(readMemoryDocument('MEMORY.md', workspaceSlug).revision)
    expect(archiveCopies()).toEqual(['deploy.md'])
  })

  test('Given 归档成功 When 查看历史 Then 旧索引已存成可恢复快照', () => {
    const theme = readMemoryDocument('deploy.md', workspaceSlug)
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    const result = archiveMemoryTheme(workspaceSlug, 'deploy.md', theme.revision, index.revision, '# 项目记忆索引\n')

    expect(result.snapshotId).toBeDefined()
    const revisionsDir = join(memoryDir(), '.revisions')
    const files = readdirSync(revisionsDir)
    expect(files.some((name) => name.includes('MEMORY'))).toBe(true)
  })

  test('Given 主题未出现在索引里 When 归档 Then 仍然可以归档', () => {
    writeFileSync(join(memoryDir(), 'orphan.md'), '# 孤儿主题\n\n- 内容\n', 'utf8')
    const theme = readMemoryDocument('orphan.md', workspaceSlug)
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    const result = archiveMemoryTheme(workspaceSlug, 'orphan.md', theme.revision, index.revision, index.content)

    expect(existsSync(join(memoryDir(), 'orphan.md'))).toBe(false)
    expect(readFileSync(result.archivedTo, 'utf8')).toContain('孤儿主题')
    // 索引本来就没有该入口，正文保持原样。
    expect(readFileSync(join(memoryDir(), 'MEMORY.md'), 'utf8')).toBe(index.content)
  })

  test('Given 主题 revision 已过期 When 归档 Then 拒绝且两个文件都没动', () => {
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'deploy.md', 'f'.repeat(64), index.revision, '# 索引\n'))
      .toThrow(MemoryError)
    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(true)
    expect(readFileSync(join(memoryDir(), 'MEMORY.md'), 'utf8')).toBe(index.content)
    expect(archiveCopies()).toEqual([])
  })

  test('Given 索引 revision 已过期 When 归档 Then 拒绝且主题仍在原位', () => {
    const theme = readMemoryDocument('deploy.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'deploy.md', theme.revision, 'a'.repeat(64), '# 索引\n'))
      .toThrow(MemoryError)
    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(true)
    expect(archiveCopies()).toEqual([])
  })

  test('Given 目标是全局画像或索引本身 When 归档 Then 拒绝', () => {
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'global-profile', 'a'.repeat(64), index.revision, '# 索引\n'))
      .toThrow('全局画像')
    expect(() => archiveMemoryTheme(workspaceSlug, 'MEMORY.md', index.revision, index.revision, '# 索引\n'))
      .toThrow('项目记忆索引')
  })

  test('Given 新索引仍保留该主题入口 When 归档 Then 拒绝并提示先移除路由', () => {
    const theme = readMemoryDocument('deploy.md', workspaceSlug)
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(
      workspaceSlug,
      'deploy.md',
      theme.revision,
      index.revision,
      '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n',
    )).toThrow('仍保留')
    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(true)
  })

  test('Given 主题不存在 When 归档 Then 拒绝', () => {
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'missing.md', 'a'.repeat(64), index.revision, '# 索引\n'))
      .toThrow(MemoryError)
  })

  test('Given 主题是符号链接 When 归档 Then 拒绝，不跟随链接移动真实文件', () => {
    const real = join(root, 'outside.md')
    writeFileSync(real, '# 外部文件\n\n- 内容\n', 'utf8')
    symlinkSync(real, join(memoryDir(), 'linked.md'))
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'linked.md', 'a'.repeat(64), index.revision, '# 索引\n'))
      .toThrow('符号链接')
    expect(readFileSync(real, 'utf8')).toContain('外部文件')
  })

  test('Given 主题超过 512 KiB When 归档 Then 拒绝并提示先拆分', () => {
    writeFileSync(join(memoryDir(), 'huge.md'), `# 巨型主题\n\n${'x'.repeat(513 * 1024)}\n`, 'utf8')
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, 'huge.md', 'a'.repeat(64), index.revision, '# 索引\n'))
      .toThrow('512 KiB')
    expect(existsSync(join(memoryDir(), 'huge.md'))).toBe(true)
  })

  test('Given 非法目标名 When 归档 Then 拒绝路径穿越', () => {
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)

    expect(() => archiveMemoryTheme(workspaceSlug, '../outside.md', 'a'.repeat(64), index.revision, '# 索引\n'))
      .toThrow('非法的记忆目标')
  })

  test('Given 归档后需要恢复 When 把归档文件搬回 Then 正文完全一致', () => {
    const theme = readMemoryDocument('deploy.md', workspaceSlug)
    const index = readMemoryDocument('MEMORY.md', workspaceSlug)
    const result = archiveMemoryTheme(workspaceSlug, 'deploy.md', theme.revision, index.revision, '# 项目记忆索引\n')

    writeFileSync(join(memoryDir(), 'deploy.md'), readFileSync(result.archivedTo, 'utf8'), 'utf8')

    expect(readMemoryDocument('deploy.md', workspaceSlug).content).toBe(theme.content)
  })
})
