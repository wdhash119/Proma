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
 *    拿不到 usage 时 fail-closed 直接返回（Proma 偏向官方压缩，见 turn_end 注释）。
 * 3. 冷却：`latestOfficialCompaction` → 身份 tracker（同一压缩 id 让过一刀，首见只建基线）
 *    + 可选时间窗（`inCooldownWindow`）。
 * 4. engine 判定：`ctx.model.provider/baseUrl` + `ctx.modelRegistry.getAll()` 兜底查
 *    provider/baseUrl，最后回落 `fallbackProviderURL`，交给算法层 `resolveEngine`
 *    （含 SPINE_ENGINE 覆盖与 Strata/本地地址识别）。
 * 5. 云端 drain：按“观测到的最大单轮增长”预测下一轮是否越过保留轮预算，或直接到紧急线。
 * 6. 选段与草案：`selectNewestChunk` → 头部保留、卡片落到工具结果、其余置 null 省略；
 *    卡片追加 `recallHint` 并把被切工具原文写进 RecallStore；卡片比原段还大时放弃这一刀。
 * 7. 多趟：云端 drain 在多轮里连续切，直到压后总量落在保留轮预算内（上游把多趟折进一次
 *    turn_end）。
 *
 * 借鉴 MerkyorLynn/pi-live-compact 0.1.4（独立实现线，非本文件上游 DSH 版本）的四项护栏：
 * 截断/中止轮不切、usage 未知 fail-closed、图片块保留、决策事件日志（live-compact-events）。
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
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ProjectedSessionEntry,
  ToolDefinition,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type {
  CallInfo,
  EngineResolution,
  OfficialCompaction,
  ProviderListing,
  RecallItem,
  SpanEntry,
} from '@proma/live-compact'
import { MARK } from '@proma/live-compact'
import type { LiveCompactAlgorithm } from './live-compact-algorithm-loader'
import type { LiveCompactThresholds } from './live-compact-thresholds'
import { appendLiveCompactEvent } from '../live-compact-events'

/** 上游胶层的两道本地护栏：切点右侧保留尾巴的上限，以及单次 turn_end 的最大趟数。 */
const MAX_TAIL_TOKENS = 2200
const MAX_PASSES = 8

/** 一张卡片最多为哪些被切工具结果留原文存档（上游同：按文本长度取前 3）。 */
const MAX_RECALL_ITEMS = 3

/**
 * 普通切割落到工具结果上时，同一条 assistant 消息（头部）的其余并行结果改写成这段 stub。
 *
 * 头部不再被替换（避免卡片继承 assistant 角色、被模型当成自己的输出模仿），因此它带的所有
 * 工具调用都必须在 span 内保留配对结果；并行的兄弟结果不能整条省略，只能换成这段占位文本，
 * 原文照常进 recall 存档，模型需要时用 spine_recall 取回。
 */
const SPINE_SIBLING_STUB = '[Spine 压缩] 同轮工具结果原文已并入本轮 Spine 卡片；需要原文时用 spine_recall 按卡片「原文存档」ref 取回。'

/** 模仿拦截后保留在消息里的正文（丢弃模型伪造的卡片文本，保留 thinking 块）。 */
const SPINE_INTERCEPTED_STUB = '[系统拦截] 上一条回复模仿了 Spine 压缩卡片格式，不是有效回复，已被替换。任务完成状态以真实工具结果为准。'

/**
 * 本段其它含图结果的图片并入卡片时的说明行。
 *
 * 借鉴 MerkyorLynn/pi-live-compact 0.1.4：上游替换只带文本，截图/图表会跟着结果一起消失，
 * 模型只能重跑工具。这里把它们的 image 块并到卡片下方，但**条目照旧置空**——
 * 后续轮次的调用方 assistant 已被置空，保留结果会产生孤儿 tool_result。
 */
export const SPINE_IMAGES_MERGED_NOTE = '[Spine 压缩] 本段其它工具结果的图片保留在卡片下方；文本原文用 spine_recall 按卡片「原文存档」ref 取回。'

/** 拦截命中后注入的纠正消息（turn_end 里以 custom_message 追加，在 LLM 上下文里转为 user 消息）。 */
const SPINE_IMITATION_CORRECTION = '【系统纠正】你上一条回复以「Spine extract.」开头，模仿了系统上下文压缩卡片的格式。那是系统生成的压缩产物，不是有效的助手回复，已被拦截移除。请不要在回复中使用该格式。现在请：1) 如果任务尚未完成（例如有仍在运行的委派、未重跑的测试、未核实的结果），继续执行必要步骤；2) 用正常语言给出当前真实状态的总结，只陈述你实际执行过的操作和真实结果，不要虚构工具调用、测试结果或委派结果。'

/** 模仿拦截的强制继续上限：超过后只保留拦截后的正文，不再要求模型继续。 */
const MAX_IMITATION_RETRIES = 2

/** 判定事件的字段：只允许水位数字、原因等短字符串，禁止工具正文。 */
type LiveCompactEventFields = Record<string, string | number | boolean | undefined>

/** 一次切段的记录，供主进程日志/未来的 UI 提示消费（v1 只做结构化日志）。 */
export interface LiveCompactCutSpanRecord {
  /** 承载卡片的条目 id（该段第一条被替换的条目）。 */
  cardEntryId: string
  /** 被这一段一并省略（replacement 置 null）的条目 id（含图条目也在其中：图片已并入卡片）。 */
  omittedEntryIds: string[]
  /** 原段 token 估算。 */
  spanTokens: number
  /** 卡片 token 估算。 */
  cardTokens: number
  /** 本段节省的 token（spanTokens - 保留量；保留量含头部、卡片与全部 stub）。 */
  savedTokens: number
  /** 写进 sidecar 的工具原文 ref（spine_recall 的参数）。 */
  recallRefs: string[]
  /** 是否是指针卡（只留调用与退出码）。 */
  pointerOnly: boolean
  /** 该段第一条条目所属轮次（会话内 user 消息计数，未知时为 null）。 */
  turn: number | null
  /** 普通切割时保留不动的 assistant 头部条目 id（指针卡与头部本身是结果时没有）。 */
  anchorEntryId?: string
  /** 被替换成 stub 的并行兄弟工具结果 id（配对保留，原文仍可从 sidecar 取回）。 */
  stubbedEntryIds?: string[]
  /** 从被省略条目并入卡片的 image 块数量（条目本体已置空，不算省略之外的保留）。 */
  mergedImageCount?: number
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
   *   命中时记一条事件（`skip` + `reason: protected_span`，历史日志里的 `skip_protected_span` 同语义）；
   * - false：完全跳过这两道护栏，恢复上游“当前轮也可被切”的行为，也不再打该事件。
   */
  protectCurrentTurn?: boolean
  /** 切段结构化记录回调；不传时切段仍然发生，只是没有记录出口。 */
  onCut?: (record: LiveCompactCutRecord) => void
  /** 时间源，测试注入；默认 Date.now。 */
  now?: () => number
  /**
   * 决策事件文件（本地 JSONL）的绝对路径；缺省时只打 console 日志。
   *
   * 借鉴 MerkyorLynn/pi-live-compact 0.1.4 的 telemetry：utility 进程日志难追溯，
   * 把 cut/skip 判定额外落成一行 JSONL（只记判定与数字，不记工具正文）。
   */
  eventsPath?: string
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

/**
 * 取条目里的 image 块（toolResult 消息的 content 数组，按原顺序）。
 *
 * 只有工具结果会带图片；content 是字符串、或消息不是 toolResult 时返回空数组。
 */
function imageBlocksOf(item: ProjectedSessionEntry | undefined): ImageContent[] {
  const images: ImageContent[] = []
  for (const message of item?.messages ?? []) {
    const record = asRecord(message)
    if (record?.role !== 'toolResult') continue
    for (const block of contentBlocks(message)) {
      const view = asRecord(block)
      if (view?.type !== 'image') continue
      if (typeof view.data !== 'string' || typeof view.mimeType !== 'string') continue
      images.push({ type: 'image', data: view.data, mimeType: view.mimeType })
    }
  }
  return images
}

/** 用「说明文本 + 原图片块」拼替换内容；条目没有图片时就是纯文本，与原来完全一致。 */
function withImageBlocks(
  text: string,
  item: ProjectedSessionEntry | undefined,
  appendImages: ImageContent[] = [],
): Array<{ type: 'text'; text: string } | ImageContent> {
  return [{ type: 'text', text }, ...imageBlocksOf(item), ...appendImages]
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
  // 本地绑定：选段/模拟都不在工厂主体里，闭包级引用能避免每处都写 algorithm.。
  const cardMark = MARK
  const estimate = (text: string): number => algorithm.estimateTokens(text)

  // 判定事件的唯一出口：console 保留现有 `[live-compact] {json}` 前缀（日志 grep 依赖它），
  // eventsPath 存在时再落一行 JSONL。日志失败绝不外抛（见 live-compact-events）。
  const emit = (event: string, fields: LiveCompactEventFields = {}): void => {
    const record = { event, sessionId: options.sessionId, ...fields }
    console.log('[live-compact] ' + JSON.stringify(record))
    if (!options.eventsPath) return
    appendLiveCompactEvent(options.eventsPath, {
      at: new Date(now()).toISOString(),
      ...record,
    })
  }

  return (pi: ExtensionAPI) => {
    // 每会话的增量状态：云端 drain 的增长基线，以及官方压缩的身份 tracker。
    // utility process 每会话一个，进程重启即重建，与上游“多会话互不影响”的前提一致。
    let turnBase: number | null = null
    let maxTurnGrowth = 0
    const compactionTracker = algorithm.createOfficialCompactionTracker()
    // 模仿拦截的强制继续计数：agent_start（新的一轮用户回合）重置。
    let imitationRetries = 0

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

    pi.on('agent_start', () => {
      imitationRetries = 0
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

      // 借鉴 MerkyorLynn/pi-live-compact 0.1.4：截断轮（length）交给 Pi 溢出恢复，
      // 中止/错误轮不做任何上下文重写；此时切段或强制继续都会干扰宿主恢复路径。
      if (event.outcome !== 'completed') {
        emit('skip', { reason: event.outcome === 'aborted' ? 'outcome_aborted' : 'outcome_error' })
        return undefined
      }
      if (event.message.role === 'assistant' && event.message.stopReason === 'length') {
        emit('skip', { reason: 'length_stop' })
        return undefined
      }

      // 卡片模仿拦截：模型把卡片格式当成自己的回复输出时（真实故障里还会顺带虚构
      // 测试/委派结果），换掉正文并强制继续一轮。本趟不做切割，压力留到下一次 turn_end。
      const interception = interceptCardImitation(event, emit, imitationRetries, cardMark)
      if (interception) {
        if (interception.forced) imitationRetries += 1
        return interception.result
      }

      const usage = ctx.getContextUsage()
      const projected = event.context.contextEntries
      // 按条目 id 反查原始投影：图片保留要拿到 toolResult 消息的真实 image 块。
      const projectedById = new Map(projected.map((item) => [item.sourceEntry.id, item]))
      let work = toSpanEntries(projected, algorithm)
      // 借鉴 0.1.4：用量未知时 fail-closed。文本估算与实际 tokenizer 偏差不可控，
      // 宁可交给官方压缩，也不按猜测的水位切割。
      if (typeof usage?.tokens !== 'number') {
        emit('skip', { reason: 'usage_unknown' })
        return undefined
      }
      const hostTotal = usage.tokens
      if (hostTotal < thresholds.minPressureTokens) {
        emit('skip', { reason: 'below_pressure', hostTokens: hostTotal, minPressureTokens: thresholds.minPressureTokens })
        return undefined
      }
      if (hostTotal >= thresholds.bigGateTokens) {
        emit('skip', { reason: 'big_gate', hostTokens: hostTotal, bigGateTokens: thresholds.bigGateTokens })
        return undefined
      }

      // 官方压缩冷却：新落地的压缩让过一刀，避免把它的摘要立刻卷进 spine 卡片；
      // 首次观测到（含“本来就有摘要”的恢复会话）只建基线，不让行。
      const official = algorithm.latestOfficialCompaction(projected)
      if (compactionTracker.observe(official)) {
        emit('skip', { reason: 'cooldown', phase: 'baseline', hostTokens: hostTotal })
        return undefined
      }
      if (algorithm.inCooldownWindow(official, thresholds.cooldownMs, now())) {
        emit('skip', { reason: 'cooldown', phase: 'window', hostTokens: hostTotal })
        return undefined
      }

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
            // 事件名保持 `skip`，reason 固定 `protected_span`，便于复盘时按原因聚合。
            emit('skip', {
              reason: 'protected_span',
              target: touchesCurrentTurn ? 'current_turn' : 'projection_tail',
              headEntryId: head.id,
            })
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
        // 先用不含并入说明的卡片文本算落点：落点决定哪些条目被省略，
        // 而被省略条目里的图片要并进卡片，卡片文本与 token 会随之变。
        const provisionalCardTokens = algorithm.estimateTokens(cardText)
        if (provisionalCardTokens >= chunk.tokens) {
          emit('skip', { reason: 'card_not_smaller', spanTokens: chunk.tokens, cardTokens: provisionalCardTokens })
          break
        }

        // 卡片落点：普通切割不再替换 assistant 头部（卡片继承 assistant 角色后，模型会把
        // 它当成自己的输出模仿），改落到 span 内第一个属于头部调用的工具结果上；头部原样
        // 保留，其并行兄弟结果换成 stub 以保住配对。指针卡（span 就是一个工具结果）与
        // 头部本身是工具结果的形态维持上游行为：卡片就地替换这条结果。
        const placement = planCardPlacement(span, head, provisionalCardTokens, estimate)
        if (!placement) break

        // 图片保留（借鉴 0.1.4）：被切段里的 image 块不能丢，但也不能靠保留条目本体——
        // 后续轮次的调用方 assistant 已被置空，保留结果会造出孤儿 tool_result
        // （pi-ai 只合成孤儿调用的结果、不清理孤儿结果，provider 会 400）。
        // 做法：卡片目标自身的图片留在卡片下方，其余被省略条目的图片按段内顺序追加；
        // 条目照旧置空。图片 token 不计入文本模拟，由下一轮宿主 usage 反映。
        const omittedCandidates: SpanEntry[] = placement.anchor
          ? span.filter(
            (target) => target.id !== placement.anchor?.id
              && target.id !== placement.cardTarget.id
              && !placement.stubbedEntryIds.includes(target.id),
          )
          : span.slice(1)
        const mergedImages: ImageContent[] = []
        for (const target of omittedCandidates) {
          mergedImages.push(...imageBlocksOf(projectedById.get(target.id)))
        }
        if (mergedImages.length > 0) cardText += `\n${SPINE_IMAGES_MERGED_NOTE}`
        const cardTokens = algorithm.estimateTokens(cardText)
        // 卡片不比原段小就没有意义：放弃这一刀，交给官方压缩。
        if (cardTokens >= chunk.tokens) {
          emit('skip', { reason: 'card_not_smaller', spanTokens: chunk.tokens, cardTokens })
          break
        }
        // 头部不再被切：assistant 头 + 卡片 + 全部 stub 的保留量不小于原段时这一刀没有收益。
        const keptTokens = placement.keptTokens - provisionalCardTokens + cardTokens
        if (keptTokens >= chunk.tokens) break

        for (const item of recallItems) store.put(item)
        const cardEntryId = placement.cardTarget.id
        const omittedEntryIds = omittedCandidates.map((target) => target.id)
        for (const targetId of omittedEntryIds) {
          drafts.push({ type: 'context_edit', targetId, replacement: null })
        }
        drafts.push({
          type: 'context_edit',
          targetId: cardEntryId,
          replacement: { content: withImageBlocks(cardText, projectedById.get(cardEntryId), mergedImages) },
        })
        for (const stubId of placement.stubbedEntryIds) {
          drafts.push({
            type: 'context_edit',
            targetId: stubId,
            replacement: { content: withImageBlocks(SPINE_SIBLING_STUB, projectedById.get(stubId)) },
          })
        }

        work = applySimulatedWork(work, chunk, placement, cardText, cardTokens, estimate)
        simulatedTotal -= chunk.tokens - keptTokens
        spans.push({
          cardEntryId,
          omittedEntryIds,
          spanTokens: chunk.tokens,
          cardTokens,
          savedTokens: chunk.tokens - keptTokens,
          recallRefs: recallItems.map((item) => item.id),
          pointerOnly: chunk.pointerOnly === true,
          turn: head.turn ?? null,
          ...(placement.anchor ? { anchorEntryId: placement.anchor.id } : {}),
          ...(placement.stubbedEntryIds.length > 0 ? { stubbedEntryIds: placement.stubbedEntryIds } : {}),
          ...(mergedImages.length > 0 ? { mergedImageCount: mergedImages.length } : {}),
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
      // 事件日志只记判定与水位数字：卡片正文、工具原文一律不进这里。
      emit('cut', {
        hostTokens: hostTotal,
        simulatedTokens: simulatedTotal,
        savedTokens: hostTotal - simulatedTotal,
        drain,
        cuts,
        engine,
        engineSource: resolution.source,
      })
      return { entries: drafts }
    })
  }
}

/**
 * 最终回复是否在模仿 Spine 卡片：assistant 消息、文本以卡片标记开头、且不带工具调用。
 *
 * 带工具调用的中间消息一律放过——替换它会破坏调用与结果的配对；outcome 不是
 * completed（error / aborted）时也不拦截，那一轮本来就不是模型的正常收尾。
 * 标记只从算法层取（`@proma/live-compact` 已按值再导出 MARK），不另写一份。
 */
function isCardImitation(message: unknown, mark: string): boolean {
  const record = asRecord(message)
  if (record?.role !== 'assistant') return false
  if (readToolCalls(message).length > 0) return false
  const text = messageText(message).trimStart()
  return text === mark || text.startsWith(mark + '\n') || text.startsWith(mark + '\r\n')
}

interface CardImitationInterception {
  result: { entries: (ContextEditEntryDraft | CustomMessageEntryDraft)[]; continue?: boolean }
  /** 本次是否算一次“强制继续”（达到上限后只替换正文，不再 continue）。 */
  forced: boolean
}

/**
 * 拦截模仿卡片的最终回复。
 *
 * 替换内容保留原消息的 thinking 块（thinking 模式的 provider 要求历史里保留它），
 * 卡片正文整段换成拦截说明；未到上限时追加一条纠正 custom_message 并 `continue:true`
 * 要求模型再答一轮，达到上限后只替换正文、不再强制继续（确定性终止）。
 */
function interceptCardImitation(
  event: TurnEndEvent,
  emit: (event: string, fields?: LiveCompactEventFields) => void,
  retries: number,
  mark: string,
): CardImitationInterception | undefined {
  if (event.outcome !== 'completed') return undefined
  if (!isCardImitation(event.message, mark)) return undefined
  const content: AssistantMessage['content'] = withInterceptionStub(event.message)
  const edit: ContextEditEntryDraft = {
    type: 'context_edit',
    targetId: event.messageEntryId,
    replacement: { content },
  }
  if (retries >= MAX_IMITATION_RETRIES) {
    emit('imitation_cap_reached', { attempt: retries })
    return { result: { entries: [edit] }, forced: false }
  }
  const attempt = retries + 1
  emit('imitation_intercepted', { attempt })
  const correction: CustomMessageEntryDraft = {
    type: 'custom_message',
    customType: 'live-compact-imitation-guard',
    content: SPINE_IMITATION_CORRECTION,
    display: false,
  }
  return { result: { entries: [edit, correction], continue: true }, forced: true }
}

/** 把消息内容里的 text 块换成拦截说明，thinking 等其余块按原顺序保留。 */
function withInterceptionStub(message: unknown): AssistantMessage['content'] {
  const kept: AssistantMessage['content'] = []
  for (const block of contentBlocks(message)) {
    const record = asRecord(block)
    if (!record) continue
    // 只丢弃模型伪造的正文（text 块）；thinking 块保留，thinking 模式的 provider 要求历史里带着它。
    if (record.type === 'text') continue
    kept.push(block as AssistantMessage['content'][number])
  }
  kept.push({ type: 'text', text: SPINE_INTERCEPTED_STUB })
  return kept
}

/**
 * 一刀的卡片落点计划。
 *
 * - `anchor` 为 null：指针卡形态（头部本身就是工具结果），卡片就地替换头部；
 * - `anchor` 非 null：普通形态，assistant/其他消息头部原样保留，卡片落到 `cardTarget`
 *   （span 内第一个属于头部调用的工具结果），头部的其余结果改写成 stub。
 */
interface CardPlacement {
  anchor: SpanEntry | null
  cardTarget: SpanEntry
  /** 被替换成 stub 的并行兄弟结果 id（保持配对）。 */
  stubbedEntryIds: string[]
  /** 切后仍留在上下文里的估算 token：头部 + 卡片 + 全部 stub。 */
  keptTokens: number
}

/**
 * 计算卡片落点；返回 null 表示这一刀必须放弃（畸形 span）。
 *
 * 普通形态要求：span 内第一个带调用的 assistant 就是头部，且它至少有一个结果落在
 * span 内。否则（头部是孤儿调用、或头部没有工具结果可承载卡片）就放弃——宁可少切
 * 一刀，也不把卡片挂到不属于头部的条目上。
 */
function planCardPlacement(
  span: SpanEntry[],
  head: SpanEntry,
  cardTokens: number,
  estimateTokens: (text: string) => number,
): CardPlacement | null {
  if (head.role === 'toolResult') {
    return { anchor: null, cardTarget: head, stubbedEntryIds: [], keptTokens: cardTokens }
  }
  const anchor = span.find((entry) => entry.role === 'assistant' && entry.toolCalls.length > 0)
  if (!anchor) return null
  const anchorResults = span.filter(
    (entry) => entry.role === 'toolResult' && entry.toolResultFor !== null && anchor.toolCalls.includes(entry.toolResultFor),
  )
  const cardTarget = anchorResults[0]
  if (!cardTarget) return null
  const stubbedEntryIds = anchorResults.slice(1).map((entry) => entry.id)
  const stubTokens = stubbedEntryIds.length * estimateTokens(SPINE_SIBLING_STUB)
  return {
    anchor,
    cardTarget,
    stubbedEntryIds,
    keptTokens: anchor.tokens + cardTokens + stubTokens,
  }
}

/**
 * 把模拟条目表换成切割后的形态，供 drain 的下一趟在同一张表上继续选段。
 *
 * 普通形态：头部原位、卡片目标位置换成 toolResult 角色的卡片条目（这样下一趟的
 * isCardEntry 仍能把它认成地板）、stub 位置换成 stub 条目、被省略的条目移除；
 * 指针形态：与上游一致，整段换成一条卡片条目。
 */
function applySimulatedWork(
  work: SpanEntry[],
  chunk: { start: number; end: number },
  placement: CardPlacement,
  cardText: string,
  cardTokens: number,
  estimateTokens: (text: string) => number,
): SpanEntry[] {
  const span = work.slice(chunk.start, chunk.end + 1)
  const head = span[0]
  if (!head) return work
  if (!placement.anchor) {
    const cardEntry = cardEntryFor(head, head.id, cardText, cardTokens, 'assistant')
    return [...work.slice(0, chunk.start), cardEntry, ...work.slice(chunk.end + 1)]
  }
  const kept: SpanEntry[] = []
  for (const entry of span) {
    if (entry.id === placement.anchor.id) {
      kept.push(entry)
      continue
    }
    if (entry.id === placement.cardTarget.id) {
      kept.push(cardEntryFor(entry, entry.id, cardText, cardTokens, 'toolResult'))
      continue
    }
    if (placement.stubbedEntryIds.includes(entry.id)) {
      const stubTokens = estimateTokens(SPINE_SIBLING_STUB)
      kept.push(cardEntryFor(entry, entry.id, SPINE_SIBLING_STUB, stubTokens, 'toolResult'))
    }
  }
  return [...work.slice(0, chunk.start), ...kept, ...work.slice(chunk.end + 1)]
}

/** 构造切后条目：保留条目原有的配对/调用/轮次信息，只换文本与角色。 */
function cardEntryFor(
  source: SpanEntry,
  id: string,
  text: string,
  tokens: number,
  role: string,
): SpanEntry {
  return {
    id,
    role,
    text,
    tokens,
    toolCalls: [],
    toolResultFor: role === 'toolResult' ? source.toolResultFor : null,
    isError: false,
    turn: source.turn ?? null,
    call: role === 'toolResult' ? source.call : null,
    backgroundStart: false,
    seq: source.seq,
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
