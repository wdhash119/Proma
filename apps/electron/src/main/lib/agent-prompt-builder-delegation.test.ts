import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 提示词构建器会读取 Electron 主进程配置；这里只提供无副作用的假实现。
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => join(tmpdir(), 'proma-delegation-prompt-electron'), getName: () => 'Proma' },
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
  memoryRoot = mkdtempSync(join(tmpdir(), 'proma-delegation-prompt-memory-'))
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
  sessionId: 'delegation-policy-test-session',
  permissionMode: 'plan' as const,
  productivityTools: { todosEnabled: false, calendarEnabled: false, obsidianEnabled: false },
  collaborationAvailable: true,
  currentModelId: 'claude-sonnet-4-5',
}

describe('系统提示词的委派策略段', () => {
  test('Given 无策略 When 构建提示词 Then 保持默认继承文案', () => {
    const prompt = buildSystemPrompt(baseContext)
    expect(prompt).toContain('委派默认复用当前模型 `claude-sonnet-4-5`；用户指定其他模型时，先查询可用模型。')
    expect(prompt).not.toContain('不要也不能为委派指定其他模型。')
  })

  test('Given inherit 策略 When 构建提示词 Then 说明固定为当前对话模型', () => {
    const prompt = buildSystemPrompt({
      ...baseContext,
      delegationPolicy: { policy: { mode: 'inherit' }, effectiveMode: 'inherit' },
    })
    expect(prompt).toContain('委派模型已由用户固定为当前对话模型；不要也不能为委派指定其他模型。')
    expect(prompt).not.toContain('委派默认复用当前模型')
    // 协作段同步声明策略固定
    expect(prompt).toContain('委派模型已由用户策略固定')
  })

  test('Given specified 策略 When 构建提示词 Then 文案含被固定的模型 id', () => {
    const prompt = buildSystemPrompt({
      ...baseContext,
      delegationPolicy: {
        policy: { mode: 'specified', channelId: 'channel-a', modelId: 'deepseek-v3' },
        effectiveMode: 'specified',
        channelName: '自定义渠道',
      },
    })
    expect(prompt).toContain('委派模型已由用户固定为 `deepseek-v3`；不要也不能为委派指定其他模型。')
    expect(prompt).not.toContain('委派默认复用当前模型')
  })

  test('Given 策略设置了上限 When 构建提示词 Then 第一轮就声明并发上限', () => {
    const prompt = buildSystemPrompt({
      ...baseContext,
      delegationPolicy: {
        policy: { mode: 'inherit', maxConcurrent: 2 },
        effectiveMode: 'inherit',
      },
    })
    expect(prompt).toContain('本会话同时运行的委派子会话上限 2 个')
    // 默认模式下用户设了上限也要可见
    const defaultPrompt = buildSystemPrompt({
      ...baseContext,
      delegationPolicy: {
        policy: { mode: 'specified', channelId: 'channel-a', modelId: 'gone', maxConcurrent: 3 },
        effectiveMode: 'default',
        fallback: { from: 'specified', reason: 'model-unavailable', channelId: 'channel-a', modelId: 'gone' },
      },
    })
    expect(defaultPrompt).toContain('本会话同时运行的委派子会话上限 3 个')
    // 未设上限时不额外声明，保持历史行为
    expect(buildSystemPrompt(baseContext)).not.toContain('本会话同时运行的委派子会话上限')
  })

  test('Given specified 降级为 default When 构建提示词 Then 回落默认文案', () => {
    const prompt = buildSystemPrompt({
      ...baseContext,
      delegationPolicy: {
        policy: { mode: 'specified', channelId: 'channel-a', modelId: 'gone' },
        effectiveMode: 'default',
        fallback: { from: 'specified', reason: 'model-unavailable', channelId: 'channel-a', modelId: 'gone' },
      },
    })
    expect(prompt).toContain('委派默认复用当前模型 `claude-sonnet-4-5`')
    expect(prompt).not.toContain('不要也不能为委派指定其他模型。')
  })
})
