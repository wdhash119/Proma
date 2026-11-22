import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  PROMA_DEFAULT_PERMISSION_MODE,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
  type ProjectInstructionSessionState,
} from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

const PROJECT_INSTRUCTION_STATE: ProjectInstructionSessionState = {
  deliveredKeys: ['D:\\project\\AGENTS.md\u0000hash-1'],
  pendingSources: [],
  consumedLegacyMigrations: [],
  pendingLegacyReminders: [],
}

type RuntimeEventListener = (event: AgentRuntimeEvent) => void
type RuntimeRequestHandler = (request: AgentRuntimeRequest) => Promise<unknown>

/** 用真实 structuredClone 模拟 Electron MessagePort 的序列化边界。 */
class FakeAgentRuntimeClient {
  static queryInput: Record<string, unknown> | undefined

  private listener: RuntimeEventListener | undefined

  constructor(_options: { sessionId: string }) {}

  setRequestHandler(_handler: RuntimeRequestHandler): void {}

  onEvent(listener: RuntimeEventListener): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  async call(method: string, payload?: unknown): Promise<unknown> {
    if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
      const start = structuredClone(payload) as { queryId: string; input: Record<string, unknown> }
      FakeAgentRuntimeClient.queryInput = start.input
      queueMicrotask(() => {
        this.emit(start.queryId, AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK, {
          callback: 'project_instruction_state',
          payload: { state: PROJECT_INSTRUCTION_STATE },
        })
        this.emit(start.queryId, AGENT_RUNTIME_METHODS.EVENT_QUERY_END, {})
      })
      return { accepted: true, queryId: start.queryId }
    }
    if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) {
      return { accepted: true, completed: true }
    }
    return { accepted: true }
  }

  async stop(): Promise<void> {}

  private emit(queryId: string, method: string, payload: unknown): void {
    this.listener?.({
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      bootId: 'test-boot',
      kind: 'event',
      method,
      sessionId: 'session-1',
      queryId,
      payload,
    })
  }
}

mock.module('../agent-runtime-client', () => ({ AgentRuntimeClient: FakeAgentRuntimeClient }))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')

function createQueryInput(
  onProjectInstructionState: (state: ProjectInstructionSessionState) => void,
): PiAgentQueryOptions {
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
    onProjectInstructionState,
  }
}

describe('Pi utility 项目指令状态回调', () => {
  test('Given 查询携带状态回调 When 跨越 MessagePort Then 输入可克隆且状态回到主进程回调', async () => {
    FakeAgentRuntimeClient.queryInput = undefined
    const receivedStates: ProjectInstructionSessionState[] = []
    const adapter = new PiUtilityAdapter()

    for await (const message of adapter.query(createQueryInput((state) => receivedStates.push(state)))) {
      void message
    }

    const queryInput = FakeAgentRuntimeClient.queryInput as Record<string, unknown> | undefined
    expect(queryInput).toBeDefined()
    expect(queryInput?.onProjectInstructionState).toBeUndefined()
    expect(() => structuredClone(queryInput)).not.toThrow()
    expect(receivedStates).toEqual([PROJECT_INSTRUCTION_STATE])
  })

  test('Given utility 重建查询输入 When 适配器保存状态 Then 通过 query callback 事件回传', () => {
    const runtimeSource = readFileSync(join(import.meta.dir, '../../../utility/agent-runtime.ts'), 'utf8')

    expect(runtimeSource).toContain('onProjectInstructionState:')
    expect(runtimeSource).toContain("sendCallback(active, 'project_instruction_state', { state })")
  })
})
