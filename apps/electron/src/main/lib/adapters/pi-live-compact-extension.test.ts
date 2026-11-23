import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ProjectedSessionEntry,
  SessionMessageEntry,
  ToolDefinition,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'
import type { CompactionEntry } from '@earendil-works/pi-coding-agent'
import {
  createLiveCompactExtension,
  type LiveCompactCutRecord,
  type LiveCompactExtensionOptions,
} from './pi-live-compact-extension'
import {
  computeLiveCompactThresholds,
  type LiveCompactThresholdOverrides,
} from './live-compact-thresholds'

/**
 * 让算法层按上游默认旋钮加载。
 *
 * `packages/live-compact/src/select.ts` 在**模块加载时**就把 SPINE_CHUNK_MIN / SPINE_CHUNK_MAX /
 * SPINE_POINTER_TOKENS / SPINE_KEEP_ROUNDS / SPINE_KEEP_ROUND_TOKENS 求值成模块级常量。
 * 仓库代码不会把这些变量写进 App 自身的 process.env（向 utility 进程 fork 时传的是独立 env 副本），
 * 但 App / Agent 会继承启动它的终端环境；调试时 export 过 SPINE_* 的终端拉起 App 后，
 * 由它派生的 `bun test` 就带着同一份覆盖。宿主一旦带覆盖进来（例如
 * SPINE_KEEP_ROUND_TOKENS=350000），保留轮预算就装得下最新三个完整工具轮，选段不再是
 * “32000 只留两轮”，本文件按默认值写就的切段期望会整体错位——这正是「首条替换成卡片」
 * 「onCut 记录」和「内存态存档退化」三个用例失败的成因，与 turn_end 的当前轮/投影尾部守卫无关。
 *
 * 仓库根的 `bunfig.toml` 已用 `[test].preload` 在标准入口（根 `bun test`）统一清理 SPINE_*；
 * 这段前导仍然保留，因为 bun 只读取**当前工作目录**的 bunfig.toml，从子目录 cwd 跑 bun test
 * 不会继承根配置。这里额外丢掉可能已被其他测试文件按污染环境加载过的算法模块实例，
 * 再重取一份干净实例，所以无论单跑、从子目录跑还是整包一起跑都稳定在默认旋钮上。
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SPINE_')) delete process.env[key]
}
const testRequire = createRequire(import.meta.url)
for (const key of Object.keys(testRequire.cache)) {
  if (/[\\/]packages[\\/]live-compact[\\/]/.test(key)) delete testRequire.cache[key]
}
const bundledAlgorithm = await import('@proma/live-compact')

const TIMESTAMP = '2026-11-22T10:00:00.000Z'
const temporaryRoots: string[] = []

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-live-compact-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function messageEntry(id: string, message: Message): ProjectedSessionEntry {
  const sourceEntry: SessionMessageEntry = {
    type: 'message',
    id,
    parentId: null,
    timestamp: TIMESTAMP,
    message,
  }
  return { sourceEntry, messages: [message] }
}

function userEntry(id: string, text: string): ProjectedSessionEntry {
  const message: UserMessage = { role: 'user', content: text, timestamp: 0 }
  return messageEntry(id, message)
}

function toolCallEntry(id: string, callId: string, name: string, text: string): ProjectedSessionEntry {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: callId, name, arguments: { path: 'big.ts' } },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: emptyUsage(),
    stopReason: 'toolUse',
    timestamp: 0,
  }
  return messageEntry(id, message)
}

function toolResultEntry(id: string, callId: string, name: string, text: string): ProjectedSessionEntry {
  const content: TextContent[] = [{ type: 'text', text }]
  const message: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content,
    isError: false,
    timestamp: 0,
  }
  return messageEntry(id, message)
}

function compactionEntry(id: string, summary: string): ProjectedSessionEntry {
  const sourceEntry: CompactionEntry = {
    type: 'compaction',
    id,
    parentId: null,
    timestamp: TIMESTAMP,
    summary,
    firstKeptEntryId: 'u1',
    tokensBefore: 1000,
  }
  const message: UserMessage = { role: 'user', content: summary, timestamp: 0 }
  return { sourceEntry, messages: [message] }
}

/** 一段“足够大但不含硬事实”的工具输出：纯 ASCII，1 token ≈ 4 字符。 */
function bigToolText(tokens: number): string {
  const line = 'const alphaWidget = buildWidget();\n'
  const repeats = Math.max(1, Math.ceil((tokens * 4) / line.length))
  return line.repeat(repeats)
}

/**
 * 四个已结束工具轮，每个结果约 15000 token（与上游 select 测试同形）：
 * 32000 的保留轮预算能装下最新两轮，因此切段落在第 1、2 轮。
 */
function toolRounds(count: number, resultTokens: number): ProjectedSessionEntry[] {
  const entries: ProjectedSessionEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const n = index + 1
    entries.push(toolCallEntry(`a${n}`, `c${n}`, 'bash', 'calling'))
    entries.push(toolResultEntry(`t${n}`, `c${n}`, 'bash', bigToolText(resultTokens)))
  }
  return entries
}

function cuttableProjection(): ProjectedSessionEntry[] {
  return [
    userEntry('u1', 'please build the widget'),
    ...toolRounds(4, 15000),
    // 尾部 assistant 会被算法走掉，只用来模拟真实回合结束形态。
    toolCallEntry('a5', 'c5', 'bash', 'done'),
  ]
}

/**
 * 以一段 40000 token 的 `read` 结果收尾的投影：该结果超过 POINTER_TOKENS（32000），
 * 会让算法把当前轮选成指针候选。六个 5000 token 的旧工具轮用于避开与本次无关的
 * 上游短投影越界边缘 case。
 */
function currentLongReadProjection(): ProjectedSessionEntry[] {
  return [
    userEntry('u1', 'inspect the large files'),
    ...toolRounds(6, 5000),
    toolCallEntry('a-current', 'call-current', 'read', 'reading current file'),
    toolResultEntry('t-current', 'call-current', 'read', bigToolText(40000)),
  ]
}

interface FakeContextOptions {
  sessionFile?: string
  tokens?: number | null
  provider?: string
  baseUrl?: string
}

/** 构造最小的 Pi ExtensionContext；只填胶层真正读取的成员。 */
function createFakeContext(options: FakeContextOptions = {}): ExtensionContext {
  const model = options.baseUrl === undefined && options.provider === undefined
    ? undefined
    : { provider: options.provider ?? 'ollama', baseUrl: options.baseUrl ?? 'http://127.0.0.1:11434', id: 'test-model' }
  const ctx = {
    ui: {},
    mode: 'rpc',
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: {
      getSessionFile: () => options.sessionFile,
    } as unknown as ExtensionContext['sessionManager'],
    modelRegistry: { getAll: () => [] } as unknown as ExtensionContext['modelRegistry'],
    model: model as unknown as ExtensionContext['model'],
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => ({
      tokens: options.tokens ?? null,
      contextWindow: 200000,
      percent: options.tokens === undefined || options.tokens === null
        ? null
        : options.tokens / 200000,
    }),
    compact: () => undefined,
    getSystemPrompt: () => '',
  }
  return ctx as unknown as ExtensionContext
}

interface TurnEndIds {
  messageEntryId?: string
  toolResultEntryIds?: string[]
}

function createTurnEndEvent(
  contextEntries: ProjectedSessionEntry[],
  ids: TurnEndIds = {},
): TurnEndEvent {
  const message: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: 'test-call',
    toolName: 'test',
    content: [],
    isError: false,
    timestamp: 0,
  }
  return {
    type: 'turn_end',
    turnIndex: 1,
    message,
    toolResults: [],
    messageEntryId: ids.messageEntryId ?? 'a5',
    toolResultEntryIds: ids.toolResultEntryIds ?? [],
    entries: [],
    continue: false,
    outcome: 'completed',
    context: {
      contextEntries,
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
  }
}

interface FakePi {
  api: ExtensionAPI
  handlers: Map<string, (event: TurnEndEvent, ctx: ExtensionContext) => unknown>
  tools: ToolDefinition[]
}

function createFakePi(): FakePi {
  const handlers = new Map<string, (event: TurnEndEvent, ctx: ExtensionContext) => unknown>()
  const tools: ToolDefinition[] = []
  const api = {
    on(event: string, handler: (event: TurnEndEvent, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler)
      return () => undefined
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool)
    },
  } as unknown as ExtensionAPI
  return { api, handlers, tools }
}

/** 测试用阈值：三条主线压到很小，其余沿用上游默认（CHUNK_MIN=1000 决定 fixture 规模）。 */
function testThresholds(overrides: LiveCompactThresholdOverrides = {}) {
  return computeLiveCompactThresholds(200000, {
    minPressureTokens: 1000,
    keepRoundTokens: 500,
    urgentTokens: 2000,
    bigGateTokens: 1000000,
    ...overrides,
  })
}

interface Harness {
  pi: FakePi
  ctx: ExtensionContext
  records: LiveCompactCutRecord[]
}

function install(options: {
  isEnabled?: () => boolean
  thresholds?: LiveCompactExtensionOptions['thresholds']
  protectCurrentTurn?: boolean
  sessionFile?: string
  tokens?: number | null
  now?: () => number
} = {}): Harness {
  const pi = createFakePi()
  const records: LiveCompactCutRecord[] = []
  const extension = createLiveCompactExtension({
    isEnabled: options.isEnabled ?? (() => true),
    sessionId: 'session-1',
    algorithm: bundledAlgorithm,
    thresholds: options.thresholds ?? testThresholds(),
    ...(options.protectCurrentTurn === undefined ? {} : { protectCurrentTurn: options.protectCurrentTurn }),
    onCut: (record) => records.push(record),
    ...(options.now ? { now: options.now } : {}),
  })
  extension(pi.api)
  const ctx = createFakeContext({
    sessionFile: options.sessionFile,
    tokens: options.tokens ?? 60400,
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
  })
  return { pi, ctx, records }
}

function runTurnEnd(
  harness: Harness,
  contextEntries: ProjectedSessionEntry[],
  ids: TurnEndIds = {},
) {
  const handler = harness.pi.handlers.get('turn_end')
  if (!handler) throw new Error('turn_end handler 未注册')
  return handler(createTurnEndEvent(contextEntries, ids), harness.ctx) as
    | { entries: ContextEditEntryDraft[] }
    | undefined
}

describe('Live Compact 胶层：算法旋钮基线', () => {
  test('Given 宿主进程带着 SPINE_* 阈值覆盖 When 本文件加载算法层 Then 选段仍按上游默认旋钮求值', () => {
    // 这两个常量决定“保留几轮、切段落在哪一轮”：预算被环境放大到装得下三个完整工具轮时，
    // 下面所有切段用例的期望都会错位。先钉住基线，让环境泄漏当场报错而不是伪装成行为回归。
    expect(bundledAlgorithm.KEEP_ROUNDS).toBe(3)
    expect(bundledAlgorithm.KEEP_ROUND_TOKENS).toBe(32000)
    expect(bundledAlgorithm.CHUNK_MIN).toBe(1000)
    expect(bundledAlgorithm.CHUNK_MAX).toBe(32000)
  })
})

describe('Live Compact 胶层：开关与压力', () => {
  test('Given 会话开关关闭 When turn_end Then 零 entries 且不记录 cut', () => {
    const harness = install({ isEnabled: () => false })
    const result = runTurnEnd(harness, cuttableProjection())
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given 上下文占用低于触发线 When turn_end Then 不切段', () => {
    const harness = install({ tokens: 999 })
    const result = runTurnEnd(harness, cuttableProjection())
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given 拿不到 usage When turn_end Then 退回逐条估算的总量判定', () => {
    const harness = install({ tokens: null })
    const result = runTurnEnd(harness, cuttableProjection())
    // 四个 15000 token 工具轮远超触发线，因此仍会切段。
    expect(result?.entries.length).toBeGreaterThan(0)
  })

  test('Given 上下文占用超过停手线 When turn_end Then 完全让位给官方压缩', () => {
    const harness = install({ tokens: 1000000 })
    expect(runTurnEnd(harness, cuttableProjection())).toBeUndefined()
  })
})

describe('Live Compact 胶层：切段草案', () => {
  test('Given 本地端点且达到触发线 When turn_end Then 首条替换成卡片、其余省略', () => {
    const harness = install()
    const result = runTurnEnd(harness, cuttableProjection())
    expect(result).toBeDefined()
    const drafts = result?.entries ?? []
    // 四个已结束工具轮保留最新两轮，切段覆盖第 1、2 轮（各一条调用 + 一条结果）。
    expect(drafts).toHaveLength(4)
    const first = drafts[0]
    expect(first?.type).toBe('context_edit')
    expect(first?.targetId).toBe('a1')
    const replacement = first?.replacement
    expect(replacement).not.toBeNull()
    const content = replacement?.content
    const text = Array.isArray(content) && content[0] && content[0].type === 'text'
      ? content[0].text
      : ''
    expect(text.startsWith('Spine extract.')).toBe(true)
    expect(text).toContain('原文存档')
    for (const draft of drafts.slice(1)) {
      expect(draft.replacement).toBeNull()
    }
    expect(drafts.map((draft) => draft.targetId)).toEqual(['a1', 't1', 'a2', 't2'])
  })

  test('Given 切段成功 When onCut Then 记录段 token、节省、卡片 id 与 recall ref', () => {
    const harness = install()
    runTurnEnd(harness, cuttableProjection())
    expect(harness.records).toHaveLength(1)
    const record = harness.records[0]
    expect(record?.sessionId).toBe('session-1')
    expect(record?.engine).toBe('local')
    expect(record?.engineSource).toBe('address')
    expect(record?.drain).toBe(false)
    expect(record?.hostTokens).toBe(60400)
    expect(record?.simulatedTokens).toBeLessThan(record?.hostTokens ?? 0)
    expect(record?.savedTokens).toBeGreaterThan(0)
    expect(record?.spans).toHaveLength(1)
    const span = record?.spans[0]
    expect(span?.cardEntryId).toBe('a1')
    expect(span?.omittedEntryIds).toEqual(['t1', 'a2', 't2'])
    expect(span?.spanTokens).toBeGreaterThan(span?.cardTokens ?? 0)
    expect(span?.savedTokens).toBe((span?.spanTokens ?? 0) - (span?.cardTokens ?? 0))
    expect(span?.recallRefs).toEqual(['t1', 't2'])
    expect(span?.pointerOnly).toBe(false)
    expect(span?.turn).toBe(1)
  })

  test('Given 没有可切段 When turn_end Then 无草案也不记录', () => {
    const harness = install()
    const result = runTurnEnd(harness, [userEntry('u1', 'short')])
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })
})

describe('Live Compact 胶层：当前轮与投影尾部保护', () => {
  test('Given 当前轮以 40000 token read 收尾 When turn_end Then 零草案且不记录 cut', () => {
    const harness = install()
    // 修复前算法会把当前轮选成指针候选，这里会返回一条指向 t-current 的草案。
    const result = runTurnEnd(harness, currentLongReadProjection(), {
      messageEntryId: 'a-current',
      toolResultEntryIds: ['t-current'],
    })
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given 保护开关关闭 When 当前轮以 40000 token read 收尾 Then 当前轮被切成卡且不打保护日志', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const harness = install({ protectCurrentTurn: false })
      const result = runTurnEnd(harness, currentLongReadProjection(), {
        messageEntryId: 'a-current',
        toolResultEntryIds: ['t-current'],
      })
      // 关闭护栏 = 回到上游行为：算法把当前长读轮选成指针候选。
      expect(result).toBeDefined()
      expect(result?.entries.map((draft) => draft.targetId)).toEqual(['a-current', 't-current'])
      expect(harness.records).toHaveLength(1)
      expect(harness.records[0]?.spans[0]?.pointerOnly).toBe(true)
      const logged = logSpy.mock.calls.map((call) => call.map((value: unknown) => String(value)).join(' '))
      expect(logged.some((line) => line.includes('skip_protected_span'))).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  })

  test('Given 保护开关为缺省 When 同一投影 Then 当前轮仍然被保护（缺省不变）', () => {
    const harness = install()
    const result = runTurnEnd(harness, currentLongReadProjection(), {
      messageEntryId: 'a-current',
      toolResultEntryIds: ['t-current'],
    })
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given messageEntryId 不可解析且工具结果 ID 为空 When turn_end Then 尾部兜底仍不替换末条', () => {
    const harness = install()
    // 生产中的 Pi 无法解析 messageEntryId 时不会派发 turn_end，此用例只钉住胶层防御。
    const result = runTurnEnd(harness, currentLongReadProjection(), {
      messageEntryId: 'unresolvable-entry',
      toolResultEntryIds: [],
    })
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given 长读轮已成为历史且尾部是新 assistant When turn_end Then 旧长读轮仍可切成指针卡', () => {
    const harness = install()
    const projected = [
      ...currentLongReadProjection(),
      toolCallEntry('a-next', 'call-next', 'bash', 'continue after the read'),
    ]
    const result = runTurnEnd(harness, projected, {
      messageEntryId: 'a-next',
      toolResultEntryIds: [],
    })
    expect(result).toBeDefined()
    const drafts = result?.entries ?? []
    // 没有永久禁用 long-read 压缩：历史长读轮照样能切成指针卡（调用条目换卡片、结果条目省略）。
    expect(drafts.map((draft) => draft.targetId)).toEqual(['a-current', 't-current'])
    expect(harness.records).toHaveLength(1)
    expect(harness.records[0]?.spans[0]?.pointerOnly).toBe(true)
  })

  test('Given 云端 drain 且首个候选是当前长读轮 When turn_end Then 本轮零切段', () => {
    const pi = createFakePi()
    const records: LiveCompactCutRecord[] = []
    createLiveCompactExtension({
      isEnabled: () => true,
      sessionId: 'session-cloud',
      algorithm: bundledAlgorithm,
      thresholds: testThresholds({ urgentTokens: 2000 }),
      onCut: (record) => records.push(record),
    })(pi.api)

    const ctx = createFakeContext({
      tokens: 60400,
      provider: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
    const result = pi.handlers.get('turn_end')?.(
      createTurnEndEvent(currentLongReadProjection(), {
        messageEntryId: 'a-current',
        toolResultEntryIds: ['t-current'],
      }),
      ctx,
    )
    // drain 同样宁可本轮不切：返回 undefined 即没有任何草案触及当前轮。
    expect(result).toBeUndefined()
    expect(records).toHaveLength(0)
  })
})

describe('Live Compact 胶层：官方压缩冷却', () => {
  test('Given 官方压缩刚落地且在冷却窗内 When turn_end Then 让过一刀', () => {
    const harness = install({
      thresholds: testThresholds({ cooldownMs: 300000 }),
      // 压缩落地后 1 秒：落在 5 分钟冷却窗内，但已过身份规则的首见基线阶段。
      now: () => Date.parse(TIMESTAMP) + 1000,
    })
    const projected = [compactionEntry('c1', '官方压缩摘要'), ...cuttableProjection()]
    const result = runTurnEnd(harness, projected)
    expect(result).toBeUndefined()
    expect(harness.records).toHaveLength(0)
  })

  test('Given 恢复会话里已有旧摘要 When 首轮 Then 只建基线不阻止切段', () => {
    const harness = install()
    const projected = [compactionEntry('c1', '官方压缩摘要'), ...cuttableProjection()]
    const result = runTurnEnd(harness, projected)
    expect(result?.entries.length).toBeGreaterThan(0)
    expect(harness.records).toHaveLength(1)
  })

  test('Given 第二轮出现新的官方压缩 When turn_end Then 正好让过这一刀', () => {
    const harness = install()
    const firstTurn = runTurnEnd(harness, cuttableProjection())
    expect(firstTurn?.entries.length).toBeGreaterThan(0)

    const liveCompaction = [compactionEntry('c2', '新的官方压缩摘要'), ...cuttableProjection()]
    const secondTurn = runTurnEnd(harness, liveCompaction)
    expect(secondTurn).toBeUndefined()

    // 同一个压缩 id 再来一次不会重复让行，切段恢复。
    const thirdTurn = runTurnEnd(harness, liveCompaction)
    expect(thirdTurn?.entries.length).toBeGreaterThan(0)
    expect(harness.records).toHaveLength(2)
  })
})

describe('Live Compact 胶层：spine_recall 工具', () => {
  test('Given 工厂加载 When 检查注册 Then spine_recall 以 typebox 参数模式注册', () => {
    const harness = install()
    expect(harness.pi.tools).toHaveLength(1)
    const tool = harness.pi.tools[0]
    expect(tool?.name).toBe('spine_recall')
    expect(tool?.parameters).toMatchObject({ type: 'object' })
    expect(tool?.promptGuidelines?.length).toBeGreaterThan(0)
  })

  test('Given 已有切段 When 用卡片 ref 调用 spine_recall Then 返回原文并存进 sidecar', async () => {
    const root = createTemporaryRoot()
    const sessionFile = join(root, 'session.jsonl')
    const harness = install({ sessionFile })

    runTurnEnd(harness, cuttableProjection())
    const sidecar = readFileSync(`${sessionFile}.spine.jsonl`, 'utf8')
    expect(sidecar).toContain('"id":"t1"')

    const tool = harness.pi.tools[0]
    if (!tool) throw new Error('spine_recall 未注册')
    const result = await tool.execute(
      'call-1',
      { ref: 't1' },
      undefined,
      undefined,
      harness.ctx as unknown as ExtensionToolContext,
    )
    const textBlocks = result.content.filter((block): block is TextContent => block.type === 'text')
    expect(textBlocks[0]?.text).toContain('的存档原文')
    expect(textBlocks[0]?.text).toContain('spine-recall-t1.txt')
    expect(result.details).toEqual({ found: true })
  })

  test('Given 未知 ref When 调用 spine_recall Then 返回未找到而不是抛错', async () => {
    const root = createTemporaryRoot()
    const harness = install({ sessionFile: join(root, 'session.jsonl') })
    const tool = harness.pi.tools[0]
    if (!tool) throw new Error('spine_recall 未注册')
    const result = await tool.execute(
      'call-2',
      { ref: 'missing' },
      undefined,
      undefined,
      harness.ctx as unknown as ExtensionToolContext,
    )
    expect(result.details).toEqual({ found: false })
    const textBlocks = result.content.filter((block): block is TextContent => block.type === 'text')
    expect(textBlocks[0]?.text).toContain('没有找到')
  })

  test('Given 无会话文件 When 切段 Then 存档退化为内存态且不影响草案', () => {
    const harness = install()
    const result = runTurnEnd(harness, cuttableProjection())
    expect(result?.entries.length).toBe(4)
  })
})

describe('Live Compact 胶层：engine 判定', () => {
  test('Given 云端地址 When turn_end Then 未到紧急线不切段', () => {
    const pi = createFakePi()
    const records: LiveCompactCutRecord[] = []
    createLiveCompactExtension({
      isEnabled: () => true,
      sessionId: 'session-cloud',
      algorithm: bundledAlgorithm,
      thresholds: testThresholds({ urgentTokens: 100000 }),
      onCut: (record) => records.push(record),
    })(pi.api)

    const ctx = createFakeContext({
      tokens: 60400,
      provider: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
    const result = pi.handlers.get('turn_end')?.(createTurnEndEvent(cuttableProjection()), ctx)
    expect(result).toBeUndefined()
    expect(records).toHaveLength(0)
  })

  test('Given 云端地址且达到紧急线 When turn_end Then drain 切段并记录 engine', () => {
    const pi = createFakePi()
    const records: LiveCompactCutRecord[] = []
    createLiveCompactExtension({
      isEnabled: () => true,
      sessionId: 'session-cloud',
      algorithm: bundledAlgorithm,
      thresholds: testThresholds({ urgentTokens: 2000 }),
      onCut: (record) => records.push(record),
    })(pi.api)

    const ctx = createFakeContext({
      tokens: 60400,
      provider: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
    const result = pi.handlers.get('turn_end')?.(createTurnEndEvent(cuttableProjection()), ctx) as
      | { entries: ContextEditEntryDraft[] }
      | undefined
    expect(result?.entries.length).toBeGreaterThan(0)
    expect(records[0]?.engine).toBe('cloud')
    expect(records[0]?.drain).toBe(true)
  })
})

describe('Live Compact 胶层：图片与自定义消息', () => {
  test('Given 含图片块的消息 When turn_end Then 只按文本块估算', () => {
    const image: ImageContent = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    const withImage: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'see screenshot' }, image],
      timestamp: 0,
    }
    const entry = messageEntry('u-image', withImage)
    const harness = install({ tokens: 2000 })
    expect(runTurnEnd(harness, [entry])).toBeUndefined()
  })
})
