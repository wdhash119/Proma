/**
 * Live Compact 的 Proma 胶层：Pi inline extension factory。
 *
 * 上游对应文件是 pi-live-compact 的 `extensions/live-compact.ts`（309 行、10 处 any）。
 * 本文件是**逐语义重写**而不是复制：宿主契约全部走 `@earendil-works/pi-coding-agent`
 * 的导出类型，算法层全部走 `@proma/live-compact` 的声明，本文件零 `any`。
 *
 * 与上游的语义对应关系（逐段）：
 * 1. 工厂注册：`spine_recall` 工具在工厂主体注册（上游同位置——注册必须发生在扩展加载期，
 *    否则首轮工具清单里没有它），`session_start` 只负责把 RecallStore 绑到会话 sidecar。
 * 2. `turn_end` 压力判定：`ctx.getContextUsage().tokens` 低于触发线直接返回；
 *    拿不到 usage 时退回逐条估算的 token 总和（上游同）。
 * 3. 冷却：`latestOfficialCompaction` → 身份 tracker（同一压缩 id 让过一刀，首见只建基线）
 *    + 可选时间窗（`inCooldownWindow`）。
 * 4. engine 判定：`ctx.model.provider/baseUrl` + `ctx.modelRegistry.getAll()` 兜底查
 *    provider/baseUrl，最后回落 `fallbackProviderURL`，交给算法层 `resolveEngine`
 *    （含 SPINE_ENGINE 覆盖与 Strata/本地地址识别）。
 * 5. 云端 drain：按“观测到的最大单轮增长”预测下一轮是否越过保留轮预算，或直接到紧急线。
 * 6. 选段与草案：`selectNewestChunk` → 第一段替换成卡片、其余置 null 省略；卡片追加
 *    `recallHint` 并把被切工具原文写进 RecallStore；卡片比原段还大时放弃这一刀。
 * 7. 多趟：云端 drain 在多轮里连续切，直到压后总量落在保留轮预算内（上游把多趟折进一次
 *    turn_end）。
 *
 * Proma 化的四处（都在参数/开关层，不动算法语义）：
 * - 阈值全部来自 `LiveCompactThresholds`（按模型窗口比例或用户设定的绝对值），不再读散落的 env 常量；
 * - 开关由 `isEnabled()` 每轮动态读取（上游 SPINE_STAND_DOWN 的等价物：关闭即不切）；
 * - 当前轮/投影末尾护栏由 `protectCurrentTurn` 门控（缺省开；关时回到上游纯算法行为）；
 * - `ctx.ui.notify` 在 utility 进程没有真正的 UI 落点（FINDINGS §5.7），改为
 *   `onCut` 结构化回调，由主进程/日志侧消费；同时**不**把总量交给算法的内部紧急线，
 *   避免算法里硬编码的 48000 抢先触发云端切段、压过 Proma 的 0.75W 紧急线（见 turn_end 注释）。
 */

import type {
  ContextEditEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ProjectedSessionEntry,
  ToolDefinition,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type {
  CallInfo,
  EngineResolution,
  OfficialCompaction,
  ProviderListing,
  RecallItem,
  SpanEntry,
} from '@proma/live-compact'
import type { LiveCompactAlgorithm } from './live-compact-algorithm-loader'
import type { LiveCompactThresholds } from './live-compact-thresholds'

/** 上游胶层的两道本地护栏：切点右侧保留尾巴的上限，以及单次 turn_end 的最大趟数。 */
const MAX_TAIL_TOKENS = 2200
const MAX_PASSES = 8

/** 一张卡片最多为哪些被切工具结果留原文存档（上游同：按文本长度取前 3）。 */
const MAX_RECALL_ITEMS = 3

/** 一次切段的记录，供主进程日志/未来的 UI 提示消费（v1 只做结构化日志）。 */
export interface LiveCompactCutSpanRecord {
  /** 承载卡片的条目 id（该段第一条被替换的条目）。 */
  cardEntryId: string
  /** 被这一段一并处理（省略）的其余条目 id。 */
  omittedEntryIds: string[]
  /** 原段 token 估算。 */
  spanTokens: number
  /** 卡片 token 估算。 */
  cardTokens: number
  /** 本段节省的 token（spanTokens - cardTokens）。 */
  savedTokens: number
  /** 写进 sidecar 的工具原文 ref（spine_recall 的参数）。 */
  recallRefs: string[]
  /** 是否是指针卡（只留调用与退出码）。 */
  pointerOnly: boolean
  /** 该段第一条条目所属轮次（会话内 user 消息计数，未知时为 null）。 */
  turn: number | null
}

/** 一次 turn_end 的完整切段记录。 */
export interface LiveCompactCutRecord {
  sessionId: string
  /** 算法判定的引擎：local / cloud。 */
  engine: string
  /** engine 判定来源（provider / address / env / unknown），便于归因。 */
  engineSource: string
  /** 切段前的上下文占用（优先取 usage.tokens）。 */
  hostTokens: number
  /** 按本次切段模拟后的占用估算。 */
  simulatedTokens: number
  /** 本次总共节省的 token。 */
  savedTokens: number
  /** 本次是否走云端 drain。 */
  drain: boolean
  spans: LiveCompactCutSpanRecord[]
  /** 记录时间（毫秒时间戳）。 */
  at: number
}

export interface LiveCompactExtensionOptions {
  /**
   * 动态开关：每次 turn_end 现读。
   * 全局开关关闭时 P2b 不加载本工厂；会话级开关关闭时这里返回 false，本轮零行为。
   */
  isEnabled: () => boolean
  /** Proma 会话 id，仅用于切段记录。 */
  sessionId: string
  /** 已解析的算法表面（bundled 或同步覆盖层，见 live-compact-algorithm-loader）。 */
  algorithm: LiveCompactAlgorithm
  /** 按模型窗口换算好的阈值（见 live-compact-thresholds）。 */
  thresholds: LiveCompactThresholds
  /**
   * 当前轮保护开关；缺省 true。
   *
   * - true：`turn_end` 携带的末条消息与工具结果（刚结束的当前轮）以及投影尾部都不被切，
   *   命中时记一条 `skip_protected_span` 日志（ec918f21 的修复）；
   * - false：完全跳过这两道护栏，恢复上游“当前轮也可被切”的行为，也不再打该日志。
   */
  protectCurrentTurn?: boolean
  /** 切段结构化记录回调；不传时切段仍然发生，只是没有记录出口。 */
  onCut?: (record: LiveCompactCutRecord) => void
  /** 时间源，测试注入；默认 Date.now。 */
  now?: () => number
}

/** 把会话条目投影翻译成算法层的 SpanEntry（上游 toSpanEntries 的 typed 版本）。 */
function toSpanEntries(
  projected: ProjectedSessionEntry[],
  algorithm: LiveCompactAlgorithm,
): SpanEntry[] {
  const entries: SpanEntry[] = []
  const callIndex = new Map<string, CallInfo>()
  let turn: number | null = null

  for (const item of projected) {
    const messages = item.messages
    const first = messages[0]
    if (!first) continue
    const firstRecord = asRecord(first)
    const role = typeof firstRecord?.role === 'string' ? firstRecord.role : 'custom'
    if (role === 'user') turn = (turn ?? 0) + 1

    const toolCalls: string[] = []
    // 与上游一致：工具调用只扫首条消息的内容块（投影里通常一对一，
    // 多条消息的文本仍然全部计入 text）。
    for (const call of readToolCalls(first)) {
      toolCalls.push(call.id)
      if (callIndex.has(call.id)) continue
      callIndex.set(call.id, {
        id: call.id,
        name: call.name,
        command: algorithm.callCommand(call.name, call.arguments),
        filePath: algorithm.callFilePath(call.arguments),
      })
    }

    const text = messages.map((message) => messageText(message)).join('\n')
    const toolResultFor = role === 'toolResult' && typeof firstRecord?.toolCallId === 'string'
      ? firstRecord.toolCallId
      : null
    entries.push({
      id: item.sourceEntry.id,
      role,
      text,
      tokens: algorithm.estimateTokens(text),
      toolCalls,
      toolResultFor,
      isError: role === 'toolResult' && firstRecord?.isError === true,
      turn,
      call: toolResultFor ? callIndex.get(toolResultFor) ?? null : null,
      backgroundStart: toolResultFor ? Boolean(algorithm.backgroundJobId(text)) : false,
      seq: entries.length,
    })
  }
  return entries
}

/**
 * AgentMessage 的窄化视图。
 *
 * Pi 的 `AgentMessage` 除 LLM 消息外还允许宿主声明合并进来的自定义消息，
 * 所以不能直接按 `UserMessage | AssistantMessage` 访问字段；这里用 `unknown` 收窄，
 * 既不写 `any`，也不假定自定义消息不出现。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** 取消息的内容块（字符串内容与自定义消息一律返回空数组）。 */
function contentBlocks(message: unknown): unknown[] {
  const content = asRecord(message)?.content
  return Array.isArray(content) ? content : []
}

/** 只保留 text 块（think 块与图片不参与算法层的文本估算）。 */
function messageText(message: unknown): string {
  const content = asRecord(message)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

interface ToolCallView {
  id: string
  name: string
  /** 原始 arguments，交给算法层的 callCommand / callFilePath 解析。 */
  arguments: unknown
}

/** 扫出消息里的工具调用块（`toolCall` + string id）。 */
function readToolCalls(message: unknown): ToolCallView[] {
  const calls: ToolCallView[] = []
  for (const block of contentBlocks(message)) {
    const record = asRecord(block)
    if (record?.type !== 'toolCall' || typeof record.id !== 'string') continue
    calls.push({
      id: record.id,
      name: typeof record.name === 'string' ? record.name : '',
      arguments: record.arguments,
    })
  }
  return calls
}

/**
 * engine 判定（上游 engineFor 的 typed 版本）。
 *
 * provider 名与 baseUrl 优先取当前模型的；baseUrl 缺失时用 modelRegistry 里的目录兜底，
 * 其中模型级 URL 优先于 provider 级 URL（上游 1.1.6 / issue #45）。
 * 任何一步失败都不能让 turn 失败：整段包在 try 里，异常时交给 fallbackProviderURL。
 */
function resolveEngineForContext(
  ctx: ExtensionContext,
  algorithm: LiveCompactAlgorithm,
): EngineResolution {
  let provider = ''
  let baseURL = ''
  try {
    const model = ctx.model
    if (model) {
      provider = typeof model.provider === 'string' ? model.provider : ''
      baseURL = typeof model.baseUrl === 'string' ? model.baseUrl : ''
    }
    if (!baseURL && provider) {
      const byProvider = new Map<string, ProviderListing>()
      for (const listed of ctx.modelRegistry.getAll()) {
        const name = typeof listed.provider === 'string' ? listed.provider : ''
        if (!name) continue
        let row = byProvider.get(name)
        if (!row) {
          row = { provider: name, id: name, baseURL: '', models: [] }
          byProvider.set(name, row)
        }
        const url = typeof listed.baseUrl === 'string' ? listed.baseUrl : ''
        if (!row.baseURL && url) row.baseURL = url
        if (listed.id && url) row.models?.push({ id: listed.id, baseURL: url })
      }
      const modelId = model && typeof model.id === 'string' ? model.id : ''
      baseURL = algorithm.lookupProviderURL(provider, [...byProvider.values()], modelId)
    }
  } catch {
    // 判定失败只影响走哪条选择策略，绝不能让正常回合失败；落到 fallback。
  }
  if (!baseURL) baseURL = algorithm.fallbackProviderURL(provider)
  return algorithm.resolveEngine({ provider, baseURL, env: process.env })
}

/** 读取会话文件路径，供 RecallStore 绑定 sidecar。 */
function readSessionFile(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile()
  } catch {
    // 拿不到会话文件时存档退化为内存态，不影响切段正确性。
    return undefined
  }
}

/**
 * 创建 Pi inline extension。
 *
 * 返回形状与仓库既有工厂一致（`(pi: ExtensionAPI) => void`），可直接放进
 * `DefaultResourceLoader({ extensionFactories })`。
 */
export function createLiveCompactExtension(
  options: LiveCompactExtensionOptions,
): (pi: ExtensionAPI) => void {
  const algorithm = options.algorithm
  const thresholds = options.thresholds
  const now = options.now ?? (() => Date.now())

  return (pi: ExtensionAPI) => {
    // 每会话的增量状态：云端 drain 的增长基线，以及官方压缩的身份 tracker。
    // utility process 每会话一个，进程重启即重建，与上游“多会话互不影响”的前提一致。
    let turnBase: number | null = null
    let maxTurnGrowth = 0
    const compactionTracker = algorithm.createOfficialCompactionTracker()

    // 被切工具原文存档：sidecar 落在会话文件同目录（`<sessionFile>.spine.jsonl`）。
    const store = new algorithm.RecallStore()
    const bindStore = (ctx: ExtensionContext): void => {
      try {
        store.bind(readSessionFile(ctx))
      } catch {
        // 存档绑定失败不能影响 turn。
      }
    }

    pi.on('session_start', (_event, ctx) => {
      bindStore(ctx)
    })

    // ---- spine_recall：把被卡片切掉的工具原文按卡片上的 ref 取回 ----
    // 注册在工厂主体（扩展加载期）：首轮的工具清单必须已经包含它，
    // 否则模型看到卡片上的 spine_recall 指针却无工具可调，只能重读源文件。
    const recallParameters = Type.Object({
      ref: Type.String({ description: "The entry id printed on the Spine card's 原文存档 line" }),
      toFile: Type.Optional(
        Type.Boolean({ description: 'Write the original to a file and return its path instead of returning it inline' }),
      ),
    })
    const recallTool: ToolDefinition<typeof recallParameters, { found: boolean }> = {
      name: 'spine_recall',
      label: 'Spine Recall',
      description:
        '取回被 Spine 卡片切掉的工具原文存档。卡片上的指针只剩摘录；需要确切原文时，用卡片「原文存档」行给出的 ref（条目 id）调用本工具，不要为了拿回被切内容而重新读取源文件。Retrieves the archived original tool output that a Spine extract card replaced, by the entry-id ref printed on the card.',
      promptSnippet: 'spine_recall: get back tool output a Spine card cut, by the ref on the card',
      promptGuidelines: [
        'When a Spine extract card cut tool output you still need, call spine_recall with the ref printed on the card instead of re-reading the source file.',
      ],
      parameters: recallParameters,
      async execute(_toolCallId, params, _signal, _onUpdate, toolCtx: ExtensionToolContext) {
        bindStore(toolCtx)
        const result = algorithm.recallResult(store, params.ref, params.toFile === true)
        return { content: [{ type: 'text', text: result.text }], details: { found: result.found } }
      },
    }
    pi.registerTool(recallTool)

    // ---- turn_end：压力判定 → 冷却 → engine → 选段 → 草案 ----
    pi.on('turn_end', (event: TurnEndEvent, ctx: ExtensionContext) => {
      if (!options.isEnabled()) return undefined
      bindStore(ctx)

      const usage = ctx.getContextUsage()
      const projected = event.context.contextEntries
      let work = toSpanEntries(projected, algorithm)
      const hostTotal = typeof usage?.tokens === 'number'
        ? usage.tokens
        : work.reduce((sum, entry) => sum + entry.tokens, 0)
      if (hostTotal < thresholds.minPressureTokens || hostTotal >= thresholds.bigGateTokens) {
        return undefined
      }

      // 官方压缩冷却：新落地的压缩让过一刀，避免把它的摘要立刻卷进 spine 卡片；
      // 首次观测到（含“本来就有摘要”的恢复会话）只建基线，不让行。
      const official = algorithm.latestOfficialCompaction(projected)
      if (compactionTracker.observe(official)) return undefined
      if (algorithm.inCooldownWindow(official, thresholds.cooldownMs, now())) return undefined

      const resolution = resolveEngineForContext(ctx, algorithm)
      const engine = resolution.engine
      const cloud = engine !== 'local'
      const growth = Math.max(0, hostTotal - (turnBase ?? hostTotal))
      maxTurnGrowth = Math.max(maxTurnGrowth, growth)
      // 云端 drain 触发：按观测到的最大单轮增长预测下一轮越过保留轮预算，
      // 或当前已到紧急线。没有增长观测时只认紧急线（上游同）。
      const projectedOver = maxTurnGrowth > 0 && hostTotal + maxTurnGrowth > thresholds.keepRoundTokens
      const drain = cloud && (projectedOver || hostTotal >= thresholds.urgentTokens)

      let simulatedTotal = hostTotal
      const drafts: ContextEditEntryDraft[] = []
      const spans: LiveCompactCutSpanRecord[] = []
      let cuts = 0

      // 本轮受保护的条目：turn_end 携带的末条消息与工具结果。
      // 集合在整次 turn_end 内不变，但每一趟都要重新检查——drain 可能先切旧段，
      // 后续 pass 才把当前轮选成候选。开关关闭时整个护栏不存在（= 上游行为）。
      const protectCurrentTurn = options.protectCurrentTurn !== false
      const protectedEntryIds = protectCurrentTurn
        ? new Set<string>([event.messageEntryId, ...event.toolResultEntryIds])
        : undefined

      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        if (drain && simulatedTotal <= thresholds.keepRoundTokens) break
        const chunk = algorithm.selectNewestChunk(work, {
          engine,
          drain,
          // 只在 drain 时把总量交给算法：算法层的 URGENT_TOKENS 是硬编码 48000、
          // 不跟随 Proma 的 0.75W 紧急线。若平时也传总量，云端会话会在 48K 就被
          // 算法内部判成 draining 而逐轮切段，绕开 Proma 的紧急线。
          ...(drain ? { totalTokens: simulatedTotal } : {}),
        })
        if (!chunk) break

        const span = work.slice(chunk.start, chunk.end + 1)
        const head = span[0]
        if (!head) break
        // 选段后守卫：候选一旦触及刚结束的当前轮或投影尾部，就停止本次后续切段。
        // 这里必须 break 而非 continue：work 与 simulatedTotal 都没变，重试只会
        // 得到同一个候选。若此前 pass 已产生安全旧段草案，保留并返回这些草案。
        // 保护开关关闭时整段跳过（包括日志），以回到上游纯算法行为。
        if (protectedEntryIds) {
          const touchesCurrentTurn = span.some((entry) => protectedEntryIds.has(entry.id))
          const touchesProjectionTail = chunk.end >= work.length - 1
          if (touchesCurrentTurn || touchesProjectionTail) {
            console.log('[live-compact] ' + JSON.stringify({
              event: 'skip_protected_span',
              sessionId: options.sessionId,
              reason: touchesCurrentTurn ? 'current_turn' : 'projection_tail',
              headEntryId: head.id,
            }))
            break
          }
        }

        const tailBeyondKept = chunk.after - (chunk.keptTokens || 0)
        if (!drain && tailBeyondKept > MAX_TAIL_TOKENS && simulatedTotal < thresholds.urgentTokens) {
          break
        }

        const recallItems = buildRecallItems(span)
        let cardText = chunk.card.text
        if (recallItems.length > 0) cardText += `\n${algorithm.recallHint(recallItems)}`
        const cardTokens = algorithm.estimateTokens(cardText)
        // 卡片不比原段小就没有意义：放弃这一刀，交给官方压缩。
        if (cardTokens >= chunk.tokens) break

        for (const item of recallItems) store.put(item)
        const cardEntryId = head.id
        const omittedEntryIds: string[] = []
        for (let index = 0; index < span.length; index += 1) {
          const target = span[index]
          if (!target) continue
          if (index === 0) {
            drafts.push({
              type: 'context_edit',
              targetId: target.id,
              replacement: { content: [{ type: 'text', text: cardText }] },
            })
            continue
          }
          omittedEntryIds.push(target.id)
          drafts.push({ type: 'context_edit', targetId: target.id, replacement: null })
        }

        const cardEntry: SpanEntry = {
          id: cardEntryId,
          role: 'assistant',
          text: cardText,
          tokens: cardTokens,
          toolCalls: [],
          toolResultFor: null,
          isError: false,
          turn: head.turn ?? null,
          call: null,
          backgroundStart: false,
          seq: head.seq,
        }
        work = [...work.slice(0, chunk.start), cardEntry, ...work.slice(chunk.end + 1)]
        simulatedTotal -= chunk.tokens - cardTokens
        spans.push({
          cardEntryId,
          omittedEntryIds,
          spanTokens: chunk.tokens,
          cardTokens,
          savedTokens: chunk.tokens - cardTokens,
          recallRefs: recallItems.map((item) => item.id),
          pointerOnly: chunk.pointerOnly === true,
          turn: head.turn ?? null,
        })
        cuts += 1
        if (!drain) break
      }

      // 基线即使没有切段也要更新（上游同）：否则下一次“增长”会把整段历史算进去。
      turnBase = simulatedTotal
      if (cuts === 0) return undefined

      if (options.onCut) {
        options.onCut({
          sessionId: options.sessionId,
          engine,
          engineSource: resolution.source,
          hostTokens: hostTotal,
          simulatedTokens: simulatedTotal,
          savedTokens: hostTotal - simulatedTotal,
          drain,
          spans,
          at: now(),
        })
      }
      return { entries: drafts }
    })
  }
}

/** 从被切段里挑出要为它留原文的工具结果（上游同：按文本长度取前 3）。 */
function buildRecallItems(span: SpanEntry[]): RecallItem[] {
  return span
    .filter((entry) => entry.role === 'toolResult' && entry.text.length > 0)
    .sort((left, right) => right.text.length - left.text.length)
    .slice(0, MAX_RECALL_ITEMS)
    .map((entry) => ({
      id: entry.id,
      label: entry.call
        ? `${entry.call.name}${entry.call.command ? ` "${entry.call.command}"` : ''}`
        : 'tool',
      text: entry.text,
    }))
}

/**
 * 供 P2b 复用的辅助：读取当前条目投影里的官方压缩状态。
 * 暴露出来是为了让主进程在写 cut 日志时用与胶层完全相同的判定。
 */
export function readLatestOfficialCompaction(
  algorithm: LiveCompactAlgorithm,
  projected: ProjectedSessionEntry[],
): OfficialCompaction | null {
  return algorithm.latestOfficialCompaction(projected)
}
