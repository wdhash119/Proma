/**
 * P4：会话级 Live Compact 开关的中途生效链行为测试。
 *
 * 覆盖三层真实行为：
 * 1. `applyLiveCompactEnabled` 的 ref 身份语义（工厂闭包必须继续读到新值）；
 * 2. `PiAgentAdapter.setLiveCompactEnabled` 改的是共享引用，而不是换对象；
 * 3. `PiUtilityAdapter.setLiveCompactEnabled` 走的是既有 query 控制 RPC 范式
 *    （fake client 记录 method 与 payload，模拟 MessagePort 边界）。
 */

import { describe, expect, mock, test } from 'bun:test'
import {
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  PROMA_DEFAULT_PERMISSION_MODE,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
} from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

type RuntimeEventListener = (event: AgentRuntimeEvent) => void
type RuntimeRequestHandler = (request: AgentRuntimeRequest) => Promise<unknown>

interface RecordedCall {
  method: string
  payload?: unknown
}

/** 用真实 structuredClone 模拟 MessagePort 序列化边界，并记录全部 RPC 调用。 */
class FakeAgentRuntimeClient {
  static calls: RecordedCall[] = []

  private listener: RuntimeEventListener | undefined
  private queryId: string | undefined

  static reset(): void {
    FakeAgentRuntimeClient.calls = []
  }

  constructor(_options: { sessionId: string }) {}

  setRequestHandler(_handler: RuntimeRequestHandler): void {}

  onEvent(listener: RuntimeEventListener): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  private emitEnd(): void {
    if (!this.queryId) return
    this.listener?.({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      bootId: 'test-boot',
      kind: 'event',
      method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
      queryId: this.queryId,
      payload: {},
    })
  }

  async call(method: string, payload?: unknown): Promise<unknown> {
    FakeAgentRuntimeClient.calls.push({ method, payload: payload ? structuredClone(payload) : undefined })
    if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
      const start = payload as { queryId: string }
      this.queryId = start.queryId
      return { accepted: true, queryId: start.queryId }
    }
    if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) {
      // 真实运行时在 abort 后会推一条 query.end，这里照同样时序收尾。
      this.emitEnd()
      return { accepted: true, completed: true }
    }
    return { accepted: true }
  }

  async stop(): Promise<void> {}
}

mock.module('../agent-runtime-client', () => ({ AgentRuntimeClient: FakeAgentRuntimeClient }))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')
const { PiAgentAdapter, applyLiveCompactEnabled } = await import('./pi-agent-adapter')

function createQueryInput(): PiAgentQueryOptions {
  return {
    sessionId: 'session-1',
    prompt: '你好',
    model: 'test-model',
    cwd: 'D:\\project',
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    provider: 'custom',
    permissionMode: PROMA_DEFAULT_PERMISSION_MODE,
    systemPrompt: '',
    piAgentDir: 'D:\\proma-test\\agent',
    piSessionDir: 'D:\\proma-test\\sessions',
  }
}

/** 让事件循环推进到 query 已进入等待队列的位置。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Live Compact 开关引用（query 起点刷新）', () => {
  test('Given 已有开关引用 When 两轮 query 传入不同生效态 Then 复用同一对象并就地刷新', () => {
    const session: { liveCompact?: { enabled: boolean } } = {}

    const first = applyLiveCompactEnabled(session, true)
    expect(first.enabled).toBe(true)

    // 第二轮：模拟下一轮 query 解析出关闭
    const second = applyLiveCompactEnabled(session, false)

    expect(second).toBe(first)
    expect(session.liveCompact).toBe(first)
    expect(first.enabled).toBe(false)
  })

  test('Given 开局关闭 When 第二轮解析出开启 Then 已有引用被打开而不是被替换', () => {
    const session: { liveCompact?: { enabled: boolean } } = {}
    const initial = applyLiveCompactEnabled(session, false)

    const refreshed = applyLiveCompactEnabled(session, true)

    expect(refreshed).toBe(initial)
    expect(initial.enabled).toBe(true)
  })
})

describe('PiAgentAdapter 运行中刷新开关', () => {
  test('Given 运行中会话已加载工厂 When 推送关闭 Then 共享引用被就地改写', async () => {
    const adapter = new PiAgentAdapter()
    // 直接注入运行态：只验证 setter 对共享引用的语义，不启动真实 Pi 会话。
    const liveCompact = { enabled: true }
    const activeSessions = (adapter as unknown as {
      activeSessions: Map<string, { liveCompact?: { enabled: boolean } }>
    }).activeSessions
    activeSessions.set('session-1', { liveCompact })

    await adapter.setLiveCompactEnabled('session-1', false)

    expect(liveCompact.enabled).toBe(false)
    expect(activeSessions.get('session-1')?.liveCompact).toBe(liveCompact)
  })

  test('Given 本轮未加载工厂 When 推送开启 Then 不创建引用也不报错', async () => {
    const adapter = new PiAgentAdapter()
    const activeSessions = (adapter as unknown as {
      activeSessions: Map<string, { liveCompact?: { enabled: boolean } }>
    }).activeSessions
    activeSessions.set('session-2', {})

    await adapter.setLiveCompactEnabled('session-2', true)

    expect(activeSessions.get('session-2')?.liveCompact).toBeUndefined()
  })
})

describe('PiUtilityAdapter 中途推送 RPC', () => {
  test('Given 运行中的查询 When 刷新开关 Then 经 setLiveCompactEnabled RPC 下发布尔值与 sessionId', async () => {
    FakeAgentRuntimeClient.reset()
    const adapter = new PiUtilityAdapter()
    const iterator = adapter.query(createQueryInput())[Symbol.asyncIterator]()
    const firstNext = iterator.next()
    await flushMicrotasks()

    FakeAgentRuntimeClient.calls = []
    await adapter.setLiveCompactEnabled('session-1', false)

    expect(FakeAgentRuntimeClient.calls).toEqual([
      {
        method: AGENT_RUNTIME_METHODS.QUERY_SET_LIVE_COMPACT,
        payload: { sessionId: 'session-1', enabled: false },
      },
    ])

    // 收尾：abort 让 fake 推 query.end，避免悬挂的迭代器留在事件循环里。
    await adapter.abort('session-1')
    await firstNext
  })

  test('Given 会话没有运行中的查询 When 刷新开关 Then 不发 RPC', async () => {
    FakeAgentRuntimeClient.reset()
    const adapter = new PiUtilityAdapter()

    await adapter.setLiveCompactEnabled('session-missing', true)

    expect(FakeAgentRuntimeClient.calls).toEqual([])
  })
})
