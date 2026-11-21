import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureMemoryFiles,
  getProjectMemoryPaths,
  hasMemoryAssociation,
  linkProjectMemory,
  memoryAssociationSection,
  resetMemoryWriteLocksForTesting,
  stripMemoryAssociation,
  withMemoryWriteLock,
} from './project-memory-scaffold'
import { MAX_MEMORY_FILE_BYTES, setMemoryRootsForTesting } from './memory-service'

let root: string
let projectRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-scaffold-'))
  projectRoot = join(root, 'project')
  mkdirSync(projectRoot, { recursive: true })
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

const ctx = (): { projectRoot: string; workspaceSlug: string } => ({ projectRoot, workspaceSlug: 'default' })

describe('记忆脚手架初始化', () => {
  test('Given 记忆文件缺失 When 初始化 Then 建立真实脚手架且不编造用户事实', () => {
    const result = ensureMemoryFiles(ctx())

    expect(result.created).toHaveLength(2)
    const profile = readFileSync(result.profile, 'utf8')
    const index = readFileSync(result.index, 'utf8')
    // 脚手架必须说明用途，但不能写入任何具体用户事实。
    expect(profile).toContain('全局用户画像')
    expect(profile).not.toContain('用户是')
    expect(index).toContain('项目记忆索引')
    expect(index).toContain('暂无已确认的项目记忆')
  })

  test('Given 已存在内容 When 再次初始化 Then 保留原内容不覆盖', () => {
    const paths = ensureMemoryFiles(ctx())
    writeFileSync(paths.profile, '# 全局用户画像\n\n- 用户是教师\n', 'utf8')

    const again = ensureMemoryFiles(ctx())

    expect(again.created).toEqual([])
    expect(readFileSync(paths.profile, 'utf8')).toContain('用户是教师')
  })
})

describe('记忆初始化数据保护', () => {
  test('Given profile 与 index 是 256–512 KiB 非空文件 When 初始化 Then 保留原内容', () => {
    const paths = ensureMemoryFiles(ctx())
    const profileContent = `# 全局用户画像\n\n${'画像事实\n'.repeat(24 * 1024)}`
    const indexContent = `# 项目记忆索引\n\n${'主题入口\n'.repeat(24 * 1024)}`
    expect(Buffer.byteLength(profileContent, 'utf8')).toBeGreaterThan(256 * 1024)
    expect(Buffer.byteLength(profileContent, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_FILE_BYTES)
    writeFileSync(paths.profile, profileContent, 'utf8')
    writeFileSync(paths.index, indexContent, 'utf8')

    const again = ensureMemoryFiles(ctx())

    expect(again.created).toEqual([])
    expect(readFileSync(paths.profile, 'utf8')).toBe(profileContent)
    expect(readFileSync(paths.index, 'utf8')).toBe(indexContent)
  })

  test('Given profile 超过 512 KiB When 初始化 Then 拒绝覆盖并保留原文件', () => {
    const paths = ensureMemoryFiles(ctx())
    const content = 'a'.repeat(MAX_MEMORY_FILE_BYTES + 1024)
    writeFileSync(paths.profile, content, 'utf8')

    expect(() => ensureMemoryFiles(ctx())).toThrow('不能自动覆盖')
    expect(readFileSync(paths.profile, 'utf8')).toBe(content)
  })

  test('Given index 是符号链接 When 初始化 Then 拒绝读写链接', () => {
    const paths = getProjectMemoryPaths(ctx())
    mkdirSync(join(root, 'global-memory'), { recursive: true })
    mkdirSync(join(root, 'workspace-memory'), { recursive: true })
    const real = join(root, 'real-index.md')
    writeFileSync(real, '# 真实索引\n', 'utf8')
    symlinkSync(real, paths.index)

    expect(() => ensureMemoryFiles(ctx())).toThrow('符号链接')
    expect(readFileSync(real, 'utf8')).toBe('# 真实索引\n')
  })

  test('Given profile 路径是目录 When 初始化 Then 拒绝静默重建', () => {
    const paths = getProjectMemoryPaths(ctx())
    mkdirSync(paths.profile, { recursive: true })

    expect(() => ensureMemoryFiles(ctx())).toThrow('不是普通文件')
  })

  test('Given 记忆文件是明确空文件 When 初始化 Then 仍然生成脚手架', () => {
    const paths = getProjectMemoryPaths(ctx())
    mkdirSync(join(root, 'global-memory'), { recursive: true })
    mkdirSync(join(root, 'workspace-memory'), { recursive: true })
    writeFileSync(paths.profile, '', 'utf8')
    writeFileSync(paths.index, '', 'utf8')

    const result = ensureMemoryFiles(ctx())

    expect(result.created).toHaveLength(2)
    expect(readFileSync(paths.profile, 'utf8')).toContain('全局用户画像')
    expect(readFileSync(paths.index, 'utf8')).toContain('项目记忆索引')
  })
})

describe('AGENTS.md 记忆关联', () => {
  test('Given AGENTS.md 不存在 When 关联 Then 建立带标记块的最小文件', () => {
    const result = linkProjectMemory(ctx())

    expect(result.changed).toBe(true)
    const content = readFileSync(result.path, 'utf8')
    expect(content).toContain('<!-- proma:memory:start -->')
    expect(content).toContain('<!-- proma:memory:end -->')
    expect(content).toContain('## 记忆维护')
    expect(hasMemoryAssociation(ctx(), content)).toBe(true)
  })

  test('Given 存在旧 CLAUDE.md When 关联 Then 保留其入口引用', () => {
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# 旧规则\n', 'utf8')

    const result = linkProjectMemory(ctx())

    expect(readFileSync(result.path, 'utf8')).toContain('[CLAUDE.md](./CLAUDE.md)')
  })

  test('Given 已有规则正文 When 关联 Then 只追加标记块并保留正文', () => {
    const original = '# 项目约定\n\n- 使用 Bun\n'
    writeFileSync(join(projectRoot, 'AGENTS.md'), original, 'utf8')

    linkProjectMemory(ctx())

    const content = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(content.startsWith('# 项目约定')).toBe(true)
    expect(content).toContain('- 使用 Bun')
    expect(content).toContain('<!-- proma:memory:start -->')
  })

  test('Given 已有关联 When 再次关联 Then 幂等不重复追加', () => {
    linkProjectMemory(ctx())
    const first = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')

    const second = linkProjectMemory(ctx())

    expect(second.changed).toBe(false)
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toBe(first)
  })

  test('Given 记忆目录变化 When 重新关联 Then 原位替换路径而非追加第二个块', () => {
    linkProjectMemory(ctx())
    // 模拟记忆根迁移：换一套目录后重新关联。
    setMemoryRootsForTesting({
      globalMemoryDir: join(root, 'global-memory-2'),
      projectMemoryDir: () => join(root, 'workspace-memory-2'),
    })

    const result = linkProjectMemory(ctx())

    const content = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(result.changed).toBe(true)
    expect(content.split('<!-- proma:memory:start -->')).toHaveLength(2)
    expect(content).toContain('global-memory-2')
  })

  test('Given AGENTS.md 是 256–512 KiB 非空文件 When 关联 Then 保留正文并追加标记块', () => {
    const original = `# 项目约定\n\n${'用户规则\n'.repeat(24 * 1024)}`
    writeFileSync(join(projectRoot, 'AGENTS.md'), original, 'utf8')

    const result = linkProjectMemory(ctx())

    const content = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(result.changed).toBe(true)
    expect(content.startsWith('# 项目约定')).toBe(true)
    expect(content).toContain('用户规则')
    expect(content).toContain('<!-- proma:memory:start -->')
  })

  test('Given AGENTS.md 超过 512 KiB When 关联 Then 拒绝覆盖并保留原文件', () => {
    const content = 'a'.repeat(MAX_MEMORY_FILE_BYTES + 1024)
    writeFileSync(join(projectRoot, 'AGENTS.md'), content, 'utf8')

    expect(() => linkProjectMemory(ctx())).toThrow('不能自动覆盖')
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toBe(content)
  })

  test('Given AGENTS.md 是符号链接 When 关联 Then 拒绝读写链接', () => {
    const real = join(root, 'real-agents.md')
    writeFileSync(real, '# 真实规则\n', 'utf8')
    symlinkSync(real, join(projectRoot, 'AGENTS.md'))

    expect(() => linkProjectMemory(ctx())).toThrow('符号链接')
    expect(readFileSync(real, 'utf8')).toBe('# 真实规则\n')
  })

  test('Given 检查后规则被外部修改 When 带旧 revision 关联 Then 中止且不写入', () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 新规则\n', 'utf8')

    expect(() => linkProjectMemory(ctx(), { expectedRevision: '0'.repeat(64) })).toThrow('外部修改')
    expect(readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')).toBe('# 项目约定\n\n- 新规则\n')
  })
})

describe('记忆关联块与预算', () => {
  test('Given 包含标记块 When 计算字符数 Then 排除脚手架部分', () => {
    const section = memoryAssociationSection(ctx())
    const content = `# 项目\n\n- 规则\n\n${section}`

    const stripped = stripMemoryAssociation(content)

    expect(stripped).not.toContain('proma:memory')
    expect(stripped).toContain('- 规则')
  })

  test('Given 生成关联块 When 检查 Then 含三条预算与绝对路径', () => {
    const section = memoryAssociationSection(ctx())
    const paths = getProjectMemoryPaths(ctx())

    expect(section).toContain('≤4000 非空白字符')
    expect(section).toContain('≤3500 字符')
    expect(section).toContain(paths.profile)
    expect(section).toContain(paths.index)
  })
})

describe('记忆写入串行锁', () => {
  test('Given 并发写入同一 key When 执行 Then 按顺序完成不互相穿插', async () => {
    const order: string[] = []
    const slow = withMemoryWriteLock('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('first')
    })
    const fast = withMemoryWriteLock('k', () => {
      order.push('second')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['first', 'second'])
  })

  test('Given 前一个任务抛错 When 后续任务执行 Then 仍能继续', async () => {
    await expect(withMemoryWriteLock('k', () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    await expect(withMemoryWriteLock('k', () => 'ok')).resolves.toBe('ok')
  })
})
