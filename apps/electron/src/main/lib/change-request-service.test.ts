import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChangeRequestService = typeof import('./change-request-service')
type ChangeRequestStore = typeof import('./change-request-store')
type SessionManager = typeof import('./agent-session-manager')
type GitHubModule = typeof import('./github-change-request-service')

let service: ChangeRequestService
let store: ChangeRequestStore
let manager: SessionManager
let github: GitHubModule
let tempHome: string
let dirA: string
let dirB: string
const originalHome = process.env.HOME
// Windows 的 os.homedir() 优先读 USERPROFILE：只设 HOME 会让夹具落到真实用户目录。
const originalUserProfile = process.env.USERPROFILE
const originalPromaDev = process.env.PROMA_DEV

/** 延迟 gh pr list 的闸门，用于模拟异步发现期间切换仓库。 */
let prListGate: Promise<void> | undefined
let releasePrList: (() => void) | undefined

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeIndex(sessions: Array<Record<string, unknown>>): void {
  const dir = join(tempHome, '.proma')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 2, sessions }), 'utf-8')
}

function sessionOf(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `会话 ${id}`,
    workspaceId: 'workspace-a',
    createdAt: 1,
    updatedAt: 2,
    agentRuntime: 'pi',
    ...extra,
  }
}

/** 用可注入的 gh runner 搭一个真实 GitHub 服务，避免访问网络或本机 gh。 */
function createGitHubService(): InstanceType<GitHubModule['ChangeRequestGitHubService']> {
  return new github.ChangeRequestGitHubService(async (program, args) => {
    if (program === 'git' && args[0] === 'remote') return 'https://github.com/acme/app.git\n'
    if (program === 'git' && args[0] === 'branch') return 'feat/topic\n'
    if (program === 'gh' && args[0] === 'repo') return '{}'
    if (program === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      if (prListGate) await prListGate
      return JSON.stringify([{
        number: 7,
        url: 'https://github.com/acme/app/pull/7',
        headRefName: 'feat/topic',
        headRepositoryOwner: { login: 'acme' },
      }])
    }
    if (program === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({
        number: 7,
        url: 'https://github.com/acme/app/pull/7',
        title: '示例 PR',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'feat/topic',
        baseRefName: 'main',
        reviewDecision: '',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
      })
    }
    throw new Error(`未预期的命令: ${program} ${args.join(' ')}`)
  })
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-change-request-service-'))
  dirA = join(tempHome, 'repo-a')
  dirB = join(tempHome, 'repo-b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  process.env.PROMA_DEV = '0'
  // 全量混跑时 config-paths 可能已被更早的文件加载并缓存真实数据根，必须先重置。
  const { resetConfigDirCacheForTests } = await import('./config-paths')
  resetConfigDirCacheForTests()
  github = await import('./github-change-request-service')
  store = await import('./change-request-store')
  manager = await import('./agent-session-manager')
  service = await import('./change-request-service')
  service.setChangeRequestGitHubServiceForTesting(createGitHubService())
})

afterAll(async () => {
  service.disposeChangeRequestService()
  service.setChangeRequestGitHubServiceForTesting(undefined)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  // 先恢复环境再重置缓存，避免本文件的 tempHome 反向污染后续文件。
  const { resetConfigDirCacheForTests } = await import('./config-paths')
  resetConfigDirCacheForTests()
  rmSync(tempHome, { recursive: true, force: true })
})

describe('异步发现期间的仓库切换', () => {
  test('Given findByHead 返回前切换 worktree When 发现完成 Then 不合并旧 scope 的绑定', async () => {
    const sessionId = 'discover-switched-worktree'
    const worktreeA = { path: dirA, mainRepoRoot: dirA, branch: 'feat/topic', selectedAt: 1 }
    const worktreeB = { path: dirB, mainRepoRoot: dirB, branch: 'feat/other', selectedAt: 2 }
    writeIndex([sessionOf(sessionId, { activeWorktree: worktreeA })])

    let release: (() => void) | undefined
    prListGate = new Promise<void>((resolve) => { release = resolve })
    releasePrList = () => release?.()

    try {
      const discovering = service.handleChangeRequestsAction({ sessionId, action: 'discover' })
      // 让发现流程先跑到 findByHead 的等待点。
      await Bun.sleep(10)
      manager.updateAgentSessionMeta(sessionId, { activeWorktree: worktreeB })
      releasePrList?.()
      const result = await discovering

      expect(result.bindings).toEqual([])
      expect(store.listBindings(sessionId)).toEqual([])
    } finally {
      prListGate = undefined
      releasePrList = undefined
    }
  })

  test('Given 发现期间 worktree 未变 When 发现完成 Then 正常合并当前仓库的 PR', async () => {
    const sessionId = 'discover-stable-worktree'
    const worktreeA = { path: dirA, mainRepoRoot: dirA, branch: 'feat/topic', selectedAt: 1 }
    writeIndex([sessionOf(sessionId, { activeWorktree: worktreeA })])

    const result = await service.handleChangeRequestsAction({ sessionId, action: 'discover' })

    expect(result.bindings.map((binding) => binding.url)).toEqual(['https://github.com/acme/app/pull/7'])
    expect(store.listBindings(sessionId)).toHaveLength(1)
  })
})

describe('引用命令的流式观察', () => {
  test('Given gh pr view 的 tool_use 与带 URL 的 tool_result When 观察流 When 完整到达 Then 绑定为 referenced', async () => {
    const sessionId = 'observe-reference-command'
    writeIndex([sessionOf(sessionId, {
      activeWorktree: { path: dirA, mainRepoRoot: dirA, branch: 'feat/topic', selectedAt: 1 },
    })])

    service.observeAgentStreamPayload(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', id: 'tool-view', input: { command: 'gh pr view 7' } }],
        },
      },
    })
    service.observeAgentStreamPayload(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-view', content: 'https://github.com/acme/app/pull/7\n' }],
        },
      },
    })

    // 绑定写入是异步发现的副作用，等它落到会话元数据。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (store.listBindings(sessionId).length > 0) break
      await Bun.sleep(10)
    }

    const bindings = store.listBindings(sessionId)
    expect(bindings.map((binding) => binding.url)).toEqual(['https://github.com/acme/app/pull/7'])
    expect(bindings[0]?.source).toBe('referenced')
  })
})

describe('启动时迁移旧版绑定', () => {  test('Given 只有旧 pullRequest 的会话 When 服务启动 Then 迁移后进入轮询集', () => {
    const sessionId = 'legacy-pull-request'
    writeIndex([sessionOf(sessionId, {
      pullRequest: {
        host: 'github.com',
        owner: 'acme',
        repo: 'app',
        number: 8,
        title: '旧版 PR',
        state: 'OPEN',
        updatedAt: 5,
      },
    })])

    service.initChangeRequestService()

    const meta = manager.listAgentSessions().find((session) => session.id === sessionId)
    expect(meta?.pullRequest).toBeUndefined()
    expect(meta?.changeRequests?.map((binding) => binding.url)).toEqual(['https://github.com/acme/app/pull/8'])
    expect(store.listBoundSessions().some((entry) => entry.sessionId === sessionId)).toBe(true)
  })
})
