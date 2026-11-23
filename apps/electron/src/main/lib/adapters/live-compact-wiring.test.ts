import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  PROMA_DEFAULT_PERMISSION_MODE,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
} from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { computeLiveCompactThresholds } from './live-compact-thresholds'
import type { LiveCompactQueryInput } from '../live-compact-settings'

type RuntimeEventListener = (event: AgentRuntimeEvent) => void
type RuntimeRequestHandler = (request: AgentRuntimeRequest) => Promise<unknown>
type ClientOptions = { sessionId: string; env?: NodeJS.ProcessEnv }

/** 用真实 structuredClone 模拟 MessagePort 序列化边界，并记录 fork 参数里的 env。 */
class FakeAgentRuntimeClient {
  static lastOptions: ClientOptions | undefined
  static queryInput: Record<string, unknown> | undefined

  /** 重置捕获状态；不在测试里直接给静态字段赋 undefined，避免 TS 控制流把类型收窄成 never。 */
  static reset(): void {
    FakeAgentRuntimeClient.lastOptions = undefined
    FakeAgentRuntimeClient.queryInput = undefined
  }

  private listener: RuntimeEventListener | undefined

  constructor(options: ClientOptions) {
    FakeAgentRuntimeClient.lastOptions = options
  }

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
        this.listener?.({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          bootId: 'test-boot',
          kind: 'event',
          method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
          sessionId: 'session-1',
          queryId: start.queryId,
          payload: {},
        })
      })
      return { accepted: true, queryId: start.queryId }
    }
    if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) {
      return { accepted: true, completed: true }
    }
    return { accepted: true }
  }

  async stop(): Promise<void> {}
}

mock.module('../agent-runtime-client', () => ({ AgentRuntimeClient: FakeAgentRuntimeClient }))

const { PiUtilityAdapter } = await import('./pi-utility-adapter')

function createQueryInput(liveCompact?: LiveCompactQueryInput): PiAgentQueryOptions {
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
    ...(liveCompact ? { liveCompact } : {}),
  }
}

const liveCompactInput: LiveCompactQueryInput = {
  enabled: true,
  thresholds: computeLiveCompactThresholds(200_000),
  protectCurrentTurn: true,
  configDir: 'D:\\proma-test',
}

describe('Live Compact fork env 注入', () => {
  test('Given 会话已启用 When 启动 utility 进程 Then 注入同源 SPINE_* env', async () => {
    FakeAgentRuntimeClient.reset()
    const adapter = new PiUtilityAdapter()

    for await (const message of adapter.query(createQueryInput(liveCompactInput))) {
      void message
    }

    const env = FakeAgentRuntimeClient.lastOptions?.env
    expect(env).toBeDefined()
    // 200K 窗口的触发线 / 保留轮预算按阈值单源换算后的值，不允许在这里重新计算。
    expect(env?.SPINE_MIN_TOKENS).toBe('100000')
    expect(env?.SPINE_KEEP_ROUND_TOKENS).toBe('70000')
    expect(env?.SPINE_CHUNK_MIN).toBe('1000')
    expect(env?.SPINE_CHUNK_MAX).toBe('32000')
    expect(env?.SPINE_POINTER_TOKENS).toBe('32000')
    expect(env?.SPINE_KEEP_ROUNDS).toBe('3')
    // 只注入算法层读取的键，不夹带胶层自用阈值。
    expect(Object.keys(env ?? {}).every((key) => key.startsWith('SPINE_'))).toBe(true)
  })

  test('Given 会话已启用 When 跨 MessagePort 下发查询 Then 阈值随输入原样到达 utility 侧', async () => {
    FakeAgentRuntimeClient.reset()
    const adapter = new PiUtilityAdapter()

    for await (const message of adapter.query(createQueryInput(liveCompactInput))) {
      void message
    }

    const queryInput = FakeAgentRuntimeClient.queryInput
    expect(queryInput).toBeDefined()
    expect(queryInput?.liveCompact).toEqual(liveCompactInput)
    expect(() => structuredClone(queryInput)).not.toThrow()
  })

  test('Given 默认关闭 When 启动 utility 进程 Then 不注入 env 且查询输入无该字段', async () => {
    FakeAgentRuntimeClient.reset()
    const adapter = new PiUtilityAdapter()

    for await (const message of adapter.query(createQueryInput())) {
      void message
    }

    expect(FakeAgentRuntimeClient.lastOptions?.env).toBeUndefined()
    expect(FakeAgentRuntimeClient.queryInput?.liveCompact).toBeUndefined()
  })
})

describe('Live Compact 接线契约（源码级）', () => {
  const read = (file: string): string => readFileSync(join(import.meta.dir, file), 'utf8')

  test('Given utility adapter When 注入 fork env Then 只读阈值单源记录，不二次计算', () => {
    const source = read('pi-utility-adapter.ts')
    expect(source).toContain('input.liveCompact?.enabled ? input.liveCompact.thresholds.env : undefined')
    // 单源护栏：阈值求值只允许出现在 live-compact-settings（主进程组装侧）。
    expect(source).not.toContain('computeLiveCompactThresholds')
  })

  test('Given Pi adapter When 组装 extensions Then 条件加入第五个工厂且 isEnabled 读可变 ref', () => {
    const source = read('pi-agent-adapter.ts')
    expect(source).toContain('...(input.liveCompact?.enabled')
    expect(source).toContain('? await createLiveCompactExtensionFactories(input.liveCompact, input.sessionId, active)')
    expect(source).toContain('createLiveCompactExtension({')
    expect(source).toContain('isEnabled: () => enabledRef.enabled')
    // 保护开关随查询输入白名单显式透传（Live Compact 字段逐项传入，不整体展开）。
    expect(source).toContain('protectCurrentTurn: liveCompact.protectCurrentTurn')
    expect(source).toContain('resolveLiveCompactAlgorithm(liveCompact.configDir')
    // cut 事件 v1 的结构化日志出口。
    expect(source).toContain("console.log('[live-compact] ' + JSON.stringify(record))")
    // 默认关闭时不加载算法，也不创建 factory；开关引用每轮按解析值刷新（保留对象身份）。
    expect(source).toContain("applyLiveCompactEnabled(active, input.liveCompact?.enabled === true)")
  })

  test('Given 编排层 When 组装查询输入 Then 用单源 helper 组装并按需下发字段', () => {
    const source = readFileSync(join(import.meta.dir, '../agent-orchestrator.ts'), 'utf8')
    expect(source).toContain('buildLiveCompactQueryInput({')
    expect(source).toContain('...(liveCompact ? { liveCompact } : {})')
    expect(source).not.toContain('computeLiveCompactThresholds')
  })

  test('Given 共享类型 When 定义会话覆盖与全局开关 Then 两处字段都存在', () => {
    const agentTypes = readFileSync(
      join(import.meta.dir, '../../../../../../packages/shared/src/types/agent.ts'),
      'utf8',
    )
    expect(agentTypes).toContain('liveCompact?: boolean')
    const settingsTypes = readFileSync(join(import.meta.dir, '../../../types/settings.ts'), 'utf8')
    expect(settingsTypes).toContain('liveCompact?: LiveCompactSettings')
    expect(settingsTypes).toContain('export interface LiveCompactSettings')
  })

  test('Given 设置服务 When 读取旧配置 Then Live Compact 缺省关闭且新字段被保留', () => {
    const source = readFileSync(join(import.meta.dir, '../settings-service.ts'), 'utf8')
    expect(source).toContain('liveCompact: { enabled: false }')
    expect(source).toContain('liveCompact: normalizeLiveCompactSettings(data.liveCompact)')
    // 归一化是读取侧唯一入口：新字段没被返回就会在“读取 → 保存”里蒸发。
    expect(source).toContain('protectCurrentTurn: raw.protectCurrentTurn !== false')
    expect(source).toContain('ratios: normalizeLiveCompactLineRatios(raw.ratios)')
    expect(source).toContain('absolute: normalizeLiveCompactLineAbsolute(raw.absolute)')
    expect(source).toContain("lineMode: raw.lineMode === 'absolute' ? 'absolute' : 'ratio'")
  })

  test('Given 组装层 When 换算四条线 Then 绝对值模式直传 token、比例模式乘窗口，lineMode 随阈值一起求值', () => {
    const source = readFileSync(join(import.meta.dir, '../live-compact-settings.ts'), 'utf8')
    expect(source).toContain('resolveLiveCompactLineOverrides(')
    expect(source).toContain('computeLiveCompactThresholds(contextWindow, overrides, { lineMode })')
    expect(source).toContain('protectCurrentTurn: input.settings?.liveCompact?.protectCurrentTurn !== false')
  })

  test('Given 胶层 When 门控当前轮护栏 Then 开关关闭时整段跳过（含 skip_protected_span 日志）', () => {
    const source = read('pi-live-compact-extension.ts')
    expect(source).toContain("const protectCurrentTurn = options.protectCurrentTurn !== false")
    expect(source).toContain('if (protectedEntryIds) {')
  })
})
