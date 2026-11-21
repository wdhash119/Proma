import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 提示词构建器会读取 Electron 主进程配置；这里只提供无副作用的假实现。
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tmpdir(), 'proma-prompt-electron'), getName: () => 'Proma' },
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

type PromptBuilderModule = typeof import('./agent-prompt-builder')
type MemoryServiceModule = typeof import('./memory-service')

let buildSystemPrompt: PromptBuilderModule['buildSystemPrompt']
let setMemoryRootsForTesting: MemoryServiceModule['setMemoryRootsForTesting']
let root: string
let memoryRoot: string

beforeAll(async () => {
  buildSystemPrompt = (await import('./agent-prompt-builder')).buildSystemPrompt
  setMemoryRootsForTesting = (await import('./memory-service')).setMemoryRootsForTesting
})

beforeEach(() => {
  // 记忆服务默认解析到真实 ~/.proma；测试必须重定向到临时目录。
  memoryRoot = mkdtempSync(join(tmpdir(), 'proma-prompt-memory-'))
  setMemoryRootsForTesting({
    globalMemoryDir: join(memoryRoot, 'global'),
    projectMemoryDir: () => join(memoryRoot, 'project'),
  })
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  if (root) rmSync(root, { recursive: true, force: true })
  rmSync(memoryRoot, { recursive: true, force: true })
})

function makeWorkspace(): { workspaceRoot: string; projectRoot: string; instructionContext: import('./project-instruction-state').ProjectInstructionContext } {
  root = mkdtempSync(join(tmpdir(), 'proma-prompt-builder-'))
  const workspaceRoot = join(root, 'workspace')
  const projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return {
    workspaceRoot,
    projectRoot,
    instructionContext: {
      projectRoot,
      canonicalProjectRoot: projectRoot,
      workspaceSlug: 'default',
      workspaceRoot,
    },
  }
}

const productivityTools = { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false }

describe('系统提示词中的项目规则段', () => {
  test('Given 尚未完成首次维护 When 构建提示词 Then 注入首次维护段', () => {
    const { instructionContext } = makeWorkspace()

    const prompt = buildSystemPrompt({
      workspaceSlug: 'default',
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
      productivityTools,
      instructionContext,
    })

    expect(prompt).toContain('## 首次项目能力维护')
    expect(prompt).toContain('ProjectInstructionsMaintain')
  })

  test('Given 项目地图缺失 When 构建提示词 Then 注入本轮项目地图行动', () => {
    const { instructionContext } = makeWorkspace()

    const prompt = buildSystemPrompt({
      workspaceSlug: 'default',
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
      productivityTools,
      instructionContext,
    })

    expect(prompt).toContain('## 本轮项目地图行动')
    expect(prompt).toContain('AGENTS.md')
  })

  test('Given 没有项目规则上下文 When 构建提示词 Then 不注入这两段', () => {
    const prompt = buildSystemPrompt({
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
      productivityTools,
    })

    expect(prompt).not.toContain('## 首次项目能力维护')
    expect(prompt).not.toContain('## 本轮项目地图行动')
  })

  test('Given 只读会话 When 构建提示词 Then 不催促首次维护', () => {
    const { instructionContext } = makeWorkspace()
    writeFileSync(join(instructionContext.workspaceRoot, 'AGENTS.md'), '# 旧外层规则\n', 'utf8')

    const prompt = buildSystemPrompt({
      workspaceSlug: 'default',
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
      productivityTools,
      instructionContext: { ...instructionContext, allowInstructionMaintenance: false },
    })

    expect(prompt).not.toContain('## 首次项目能力维护')
    // 只读会话同样不要求改写项目地图。
    expect(prompt).not.toContain('## 本轮项目地图行动')
  })
})
