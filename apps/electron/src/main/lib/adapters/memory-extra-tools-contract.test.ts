import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { buildMemoryExtraTools, type MemoryExtraToolsContext } from './pi-memory-extra-tools'
import { resetMemoryWriteLocksForTesting } from '../project-memory-scaffold'
import {
  PROJECT_INDEX_TARGET,
  readLegacyProfileLocations,
  readMemoryDocument,
  readMemoryFileAt,
  setMemoryRootsForTesting,
} from '../memory-service'

const workspaceSlug = 'demo'

interface FakeTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (toolCallId: string, params: unknown) => Promise<AgentToolResult<unknown>>
}

/** 只做定义收集的假 SDK：验证工具契约与真实执行结果，不依赖 Pi 运行时。 */
const fakeSdk = {
  defineTool: (definition: never): unknown => definition,
}

let root: string
let projectRoot: string

function memoryDir(): string {
  return join(root, 'workspaces', workspaceSlug, 'memory')
}

function globalProfilePath(): string {
  return join(root, 'global-memory', 'user_profile.md')
}

function buildTools(overrides: Partial<MemoryExtraToolsContext> = {}): FakeTool[] {
  return buildMemoryExtraTools(fakeSdk, {
    workspaceSlug,
    projectRoot,
    ...overrides,
  }) as FakeTool[]
}

function findTool(tools: FakeTool[], name: string): FakeTool {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`没有找到工具：${name}`)
  return tool
}

function payload(result: AgentToolResult<unknown>): Record<string, unknown> {
  const first = result.content[0]
  if (!first || typeof first !== 'object' || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('工具结果缺少文本内容')
  }
  return JSON.parse(first.text) as Record<string, unknown>
}

function seed(): void {
  mkdirSync(join(root, 'global-memory'), { recursive: true })
  mkdirSync(memoryDir(), { recursive: true })
  writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 先读本文件\n', 'utf8')
  writeFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n', 'utf8')
  writeFileSync(join(memoryDir(), 'deploy.md'), '# 部署\n\n- 使用 Bun 构建\n', 'utf8')
  writeFileSync(join(memoryDir(), 'user-profile.md'), '# 旧画像\n\n- 用户是教师\n', 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-memory-tools-'))
  projectRoot = join(root, 'project')
  mkdirSync(projectRoot, { recursive: true })
  setMemoryRootsForTesting({
    globalMemoryDir: join(root, 'global-memory'),
    projectMemoryDir: (slug) => join(root, 'workspaces', slug, 'memory'),
  })
  resetMemoryWriteLocksForTesting()
  seed()
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  resetMemoryWriteLocksForTesting()
  rmSync(root, { recursive: true, force: true })
})

describe('工具契约', () => {
  test('Given 可写用户会话 When 构建工具 Then 三个记忆工具都带中文标签与说明', () => {
    const names = buildTools().map((tool) => tool.name)

    expect(names).toEqual(['MemoryInitialize', 'MemoryArchive', 'MemoryMigrateProfile'])
    for (const tool of buildTools()) {
      expect(tool.label.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toBeObject()
    }
  })

  test('Given 缺少工作区 When 构建工具 Then 不提供任何记忆工具', () => {
    expect(buildTools({ workspaceSlug: undefined })).toEqual([])
  })

  test('Given 自动化或协作子会话 When 构建工具 Then 不提供画像整合工具', () => {
    const names = buildTools({ allowProfileMigration: false }).map((tool) => tool.name)

    expect(names).toEqual(['MemoryInitialize', 'MemoryArchive'])
  })

  test('Given 归档工具 When 查看参数 Then 必须同时带主题与索引 revision', () => {
    const schema = findTool(buildTools(), 'MemoryArchive').parameters

    expect(schema).toMatchObject({ type: 'object' })
    expect(Object.keys((schema as { properties: Record<string, unknown> }).properties).sort())
      .toEqual(['indexContent', 'indexRevision', 'revision', 'target'])
    expect((schema as { required: string[] }).required.sort())
      .toEqual(['indexContent', 'indexRevision', 'revision', 'target'])
  })
})

describe('MemoryInitialize', () => {
  test('Given 记忆文件缺失 When 初始化 Then 建立脚手架并在 AGENTS.md 挂上关联', async () => {
    const result = payload(await findTool(buildTools(), 'MemoryInitialize').execute('call-1', {}))

    expect(readFileSync(globalProfilePath(), 'utf8')).toContain('全局用户画像')
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toContain('项目记忆索引')
    expect(result.profilePath).toBe(globalProfilePath())
    expect(result.rulesPath).toBe(join(projectRoot, 'AGENTS.md'))
    expect(result.rulesChanged).toBe(true)
    const rules = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(rules).toContain('- 先读本文件')
    expect(rules).toContain('proma:memory:start')
  })

  test('Given 已经初始化 When 再次初始化 Then 幂等，不重复追加关联段', async () => {
    const tool = findTool(buildTools(), 'MemoryInitialize')
    await tool.execute('call-1', {})

    const again = payload(await tool.execute('call-2', {}))

    expect(again.rulesChanged).toBe(false)
    const rules = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(rules.split('proma:memory:start')).toHaveLength(2)
  })

  test('Given 没有项目根 When 初始化 Then 明确报错而不是猜路径', async () => {
    const tool = findTool(buildTools({ projectRoot: undefined }), 'MemoryInitialize')

    await expect(tool.execute('call-1', {})).rejects.toThrow('项目根目录')
  })
})

describe('MemoryArchive', () => {
  test('Given 主题已被取代 When 归档 Then 返回归档路径并更新索引', async () => {
    const index = readMemoryDocument(PROJECT_INDEX_TARGET, workspaceSlug)
    const theme = readMemoryDocument('deploy.md', workspaceSlug)
    const nextIndex = '# 项目记忆索引\n'

    const result = payload(await findTool(buildTools(), 'MemoryArchive').execute('call-1', {
      target: 'deploy.md',
      revision: theme.revision,
      indexRevision: index.revision,
      indexContent: nextIndex,
    }))

    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(false)
    expect(String(result.archivedTo)).toContain('.archive')
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(nextIndex)
    expect(result.indexRevision).toBe(readMemoryDocument(PROJECT_INDEX_TARGET, workspaceSlug).revision)
  })

  test('Given revision 已过期 When 归档 Then 抛错且不移动文件', async () => {
    const index = readMemoryDocument(PROJECT_INDEX_TARGET, workspaceSlug)

    await expect(findTool(buildTools(), 'MemoryArchive').execute('call-1', {
      target: 'deploy.md',
      revision: 'a'.repeat(64),
      indexRevision: index.revision,
      indexContent: '# 项目记忆索引\n',
    })).rejects.toThrow('重新读取')
    expect(existsSync(join(memoryDir(), 'deploy.md'))).toBe(true)
  })
})

describe('MemoryMigrateProfile', () => {
  function proposalParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const source = readLegacyProfileLocations(workspaceSlug)[0]
    if (!source) throw new Error('测试前置条件缺失：没有旧画像来源')
    const index = readMemoryDocument(PROJECT_INDEX_TARGET, workspaceSlug)
    const global = readMemoryFileAt(globalProfilePath())
    const mergedIndex = '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n'
    const mergedGlobal = '# 全局用户画像\n\n- 用户是教师（source：旧画像；scope：全局）\n'
    return {
      proposal: {
        sourceId: source.id,
        sourceRevision: source.revision,
        globalRevision: global.revision,
        globalContent: mergedGlobal,
        preferencesRevision: readMemoryFileAt(join(memoryDir(), 'project-preferences.md')).revision,
        preferencesContent: null,
        sourceIndexRevision: index.revision,
        sourceIndexContent: mergedIndex,
        indexRevision: index.revision,
        indexContent: mergedIndex,
        rationale: '去重后把教师身份并入全局画像。',
        ...overrides,
      },
    }
  }

  test('Given revision 匹配 When 迁移 Then 返回 migrated 并归档旧画像', async () => {
    const result = payload(await findTool(buildTools(), 'MemoryMigrateProfile').execute('call-1', proposalParams()))

    expect(result.status).toBe('migrated')
    expect(String(result.migrationId)).toMatch(/^[a-f0-9-]{36}$/)
    expect(readFileSync(globalProfilePath(), 'utf8')).toContain('用户是教师')
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(false)
    expect(existsSync(String(result.archivedSourceTo))).toBe(true)
  })

  test('Given globalRevision 不匹配 When 迁移 Then 返回 reconciliation_required 且不写任何文件', async () => {
    const result = payload(await findTool(buildTools(), 'MemoryMigrateProfile').execute('call-1', proposalParams({
      globalRevision: 'b'.repeat(64),
    })))

    expect(result.status).toBe('reconciliation_required')
    expect(result.saved).toBe(false)
    expect(Array.isArray(result.issues)).toBe(true)
    expect((result.issues as string[]).join('\n')).toContain('全局画像')
    expect(result.maxChars).toBe(5000)
    // 全局画像本就不存在（首次迁移前的空正文 revision），冲突时不会凭空创建它。
    expect(existsSync(globalProfilePath())).toBe(false)
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).not.toContain('教师')
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(true)
  })

  test('Given 同时传 proposal 与 resumeId When 迁移 Then 拒绝', async () => {
    await expect(findTool(buildTools(), 'MemoryMigrateProfile').execute('call-1', {
      ...proposalParams(),
      resumeId: '11111111-1111-1111-1111-111111111111',
    })).rejects.toThrow('请提供 proposal、resumeId 或 replanId 中的一个')
  })

  test('Given 什么都不传 When 迁移 Then 拒绝', async () => {
    await expect(findTool(buildTools(), 'MemoryMigrateProfile').execute('call-1', {}))
      .rejects.toThrow('请提供 proposal、resumeId 或 replanId 中的一个')
  })

  test('Given 已完成迁移 When 用 replanId 退役 Then 拒绝，不允许改写历史', async () => {
    const migrated = payload(await findTool(buildTools(), 'MemoryMigrateProfile').execute('call-1', proposalParams()))

    await expect(findTool(buildTools(), 'MemoryMigrateProfile').execute('call-2', {
      replanId: migrated.migrationId,
    })).rejects.toThrow('迁移已完成')
  })
})
