import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PERSONAS, type Persona } from '@proma/shared'

// 提示词构建器会读取 Electron 主进程配置；这里只提供无副作用的假实现。
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tmpdir(), 'proma-persona-prompt-electron'), getName: () => 'Proma' },
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
let memoryRoot: string

beforeAll(async () => {
  buildSystemPrompt = (await import('./agent-prompt-builder')).buildSystemPrompt
  setMemoryRootsForTesting = (await import('./memory-service')).setMemoryRootsForTesting
})

beforeEach(() => {
  memoryRoot = mkdtempSync(join(tmpdir(), 'proma-persona-prompt-memory-'))
  setMemoryRootsForTesting({
    globalMemoryDir: join(memoryRoot, 'global'),
    projectMemoryDir: () => join(memoryRoot, 'project'),
  })
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  rmSync(memoryRoot, { recursive: true, force: true })
})

const baseContext = {
  sessionId: 'persona-test-session',
  permissionMode: 'plan' as const,
  productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
}

const customPersona: Persona = {
  id: 'custom-1',
  name: '工程核',
  description: '',
  body: '证据优先，最小改动。',
  createdAt: 1,
  updatedAt: 1,
}

describe('系统提示词的人设段', () => {
  test('Given 未提供人设 When 构建提示词 Then 不含人设段', () => {
    const prompt = buildSystemPrompt(baseContext)
    expect(prompt).not.toContain('## 人设')
  })

  test('Given 默认助手人设 When 构建提示词 Then 不注入（产品提示词已覆盖）', () => {
    const prompt = buildSystemPrompt({ ...baseContext, persona: BUILTIN_PERSONAS[0] })
    expect(prompt).not.toContain('## 人设')
  })

  test('Given 自定义人设 When 构建提示词 Then 人设段紧跟身份开场段且保留产品契约', () => {
    const prompt = buildSystemPrompt({ ...baseContext, persona: customPersona })
    const personaIndex = prompt.indexOf('## 人设：工程核')
    const runtimeIndex = prompt.indexOf('## Pi 运行时')
    expect(personaIndex).toBeGreaterThan(-1)
    expect(runtimeIndex).toBeGreaterThan(personaIndex)
    expect(prompt).toContain('证据优先，最小改动。')
    expect(prompt).toContain('安全契约冲突时，以后者为准')
    // 产品契约段不受影响
    expect(prompt).toContain('## 回复')
    expect(prompt).toContain('## 知识维护与访问边界')
  })

  test('Given 空正文人设 When 构建提示词 Then 不注入', () => {
    const prompt = buildSystemPrompt({ ...baseContext, persona: { ...customPersona, body: '   ' } })
    expect(prompt).not.toContain('## 人设')
  })
})