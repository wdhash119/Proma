import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 适配器链路会加载 Electron 主进程模块，这里只提供无副作用的假实现，
// 保证测试不建真实窗口、不碰用户配置目录。
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tmpdir(), 'proma-electron-test'), getName: () => 'Proma' },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))
import { setMemoryRootsForTesting } from '../memory-service'
import { hasMemoryAssociation, resetMemoryWriteLocksForTesting } from '../project-memory-scaffold'
import type { ProjectInstructionContext } from '../project-instruction-state'

/** 适配器依赖 Electron 主进程模块，只能在 mock 生效后动态加载。 */
type InstructionToolsModule = typeof import('./pi-instruction-migration-tools')
let buildInstructionMigrationTools: InstructionToolsModule['buildInstructionMigrationTools']

interface StubTool {
  name: string
  execute: (toolCallId: string, params?: unknown) => Promise<{ details: Record<string, unknown> }>
}

beforeAll(async () => {
  const module = await import('./pi-instruction-migration-tools')
  buildInstructionMigrationTools = module.buildInstructionMigrationTools
})

afterAll(() => {
  mock.restore()
})

let root: string
let projectRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-instruction-tools-'))
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

/** Pi 只用到 defineTool；桩直接把定义原样返回。 */
const sdk = { defineTool: (definition: unknown) => definition }

function toolsFor(ctx: ProjectInstructionContext): StubTool[] {
  return buildInstructionMigrationTools(sdk, ctx) as StubTool[]
}

function toolNamed(tools: StubTool[], name: string): StubTool {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`缺少工具 ${name}`)
  return tool
}

describe('项目规则工具注入', () => {
  test('Given 用户主会话 When 构建工具 Then 提供 7 个规则与地图工具', () => {
    const names = toolsFor(makeCtx()).map((tool) => tool.name)

    expect(names).toEqual([
      'ProjectInstructionsMaintain',
      'ProjectInstructionsInspect',
      'ProjectInstructionsMigrate',
      'ProjectInstructionsResume',
      'ProjectInstructionsReplan',
      'ProjectMapInspect',
      'ProjectMapReviewComplete',
    ])
  })

  test('Given 只读会话 When 构建工具 Then 只保留无副作用的读取工具', () => {
    const names = toolsFor(makeCtx({ allowInstructionMaintenance: false })).map((tool) => tool.name)

    expect(names).toEqual(['ProjectInstructionsInspect', 'ProjectMapInspect'])
  })

  test('Given 未先检查 When 提交迁移 Then 要求重新检查', async () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')
    const tools = toolsFor(makeCtx())

    await expect(toolNamed(tools, 'ProjectInstructionsMigrate').execute('call-1', {
      targetRevision: 'a'.repeat(64),
      sources: [{ path: join(workspaceRoot, 'AGENTS.md'), revision: 'b'.repeat(64) }],
      content: '# 合并\n',
      summary: '合并',
    })).rejects.toThrow('请先重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并')
  })

  test('Given 已检查 When 提交迁移 Then 写入规则并自动关联记忆', async () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n\n- 旧命令\n', 'utf8')
    const tools = toolsFor(makeCtx())
    const inspect = await toolNamed(tools, 'ProjectInstructionsInspect').execute('call-1')
    const state = inspect.details as {
      target: { revision: string }
      sources: Array<{ path: string; revision: string }>
    }

    const result = await toolNamed(tools, 'ProjectInstructionsMigrate').execute('call-2', {
      targetRevision: state.target.revision,
      sources: state.sources.map((source) => ({ path: source.path, revision: source.revision })),
      content: '# 项目约定\n\n- 旧命令\n',
      summary: '保留旧命令',
    })

    expect(result.details.status).toBe('ready')
    expect(result.details.userFacingNotice).toContain('这次也顺手完善了项目的 Agent 协作能力')
    const target = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
    expect(target).toContain('旧命令')
    expect(hasMemoryAssociation({ projectRoot, workspaceSlug: 'default' }, target)).toBe(true)
    expect(existsSync(join(workspaceRoot, 'AGENTS.md'))).toBe(false)
  })

  test('Given 两侧冲突 When 检查后直接维护 Then 提示需要语义合并', async () => {
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 项目侧规则\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    const result = await toolsFor(makeCtx())[0]!.execute('call-1')

    expect(result.details.status).toBe('needs-merge')
  })

  test('Given 空项目 When 调用维护 Then 建立脚手架并返回 ready', async () => {
    const result = await toolsFor(makeCtx())[0]!.execute('call-1')

    expect(result.details.status).toBe('ready')
    expect(existsSync(join(projectRoot, 'AGENTS.md'))).toBe(true)
  })

  test('Given 未读取项目地图 When 记录检查完成 Then 要求先读取', async () => {
    await toolsFor(makeCtx())[0]!.execute('call-1')

    await expect(toolNamed(toolsFor(makeCtx()), 'ProjectMapReviewComplete').execute('call-2', {
      revision: 'a'.repeat(64),
      summary: '已核验',
    })).rejects.toThrow('请先使用 ProjectMapInspect')
  })

  test('Given 已读取项目地图 When 记录检查完成 Then 保存复查时间', async () => {
    await toolsFor(makeCtx())[0]!.execute('call-1')
    const tools = toolsFor(makeCtx())
    const inspect = await toolNamed(tools, 'ProjectMapInspect').execute('call-2')
    const revision = (inspect.details as { revision: string }).revision

    const record = await toolNamed(tools, 'ProjectMapReviewComplete').execute('call-3', {
      revision,
      summary: '核验了命令与目录结构，无需更新',
    })

    expect((record.details as { revision: string }).revision).toBe(revision)
    const state = await toolNamed(toolsFor(makeCtx()), 'ProjectMapInspect').execute('call-4')
    expect((state.details as { checkedAt?: number }).checkedAt).toBeGreaterThan(0)
  })
})
