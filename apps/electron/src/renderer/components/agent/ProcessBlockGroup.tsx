import * as React from 'react'
import { ChevronRight, Scissors } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  USER_DRIVE_WINDOW_MS,
  decideFollowOnScroll,
  decideFollowOnWheel,
  getFollowDistance,
  innerViewportOwnsWheel,
  shouldForceFollowBottom,
  type ConversationFollowMode,
  type FollowScrollMetrics,
} from '@/lib/conversation-follow'
import { getToolDisplayName, getToolIcon } from './tool-utils'
import { SpineCutProcessRow } from './SpineCutNotice'
import type {
  SDKContentBlock,
  SDKSystemMessage,
  SDKToolUseBlock,
  SDKTextBlock,
  SDKThinkingBlock,
} from '@proma/shared'

/**
 * 按「显示压缩事件」开关过滤顶层内容块（纯函数，便于单测）。
 *
 * showEvents 为 false 时隐藏 spine_recall（原文召回）工具块——它是 Live Compact
 * 在转录里除切割通知外的唯一可见痕迹，开关关闭时与通知一并隐藏。true 时原样返回。
 * 只作用于顶层块；子代理内部块不受影响（spine_recall 不会出现在子代理里）。
 * 在 buildAssistantTurnRenderItems 之前调用，保证单独渲染与过程组聚合一致排除。
 */
export function filterVisibleTopLevelBlocks(
  blocks: SDKContentBlock[],
  showEvents: boolean,
): SDKContentBlock[] {
  if (showEvents) return blocks
  return blocks.filter((block) => !(block.type === 'tool_use' && block.name === 'spine_recall'))
}

interface ProcessBlockGroupProps {
  blocks: SDKContentBlock[]
  /**
   * 归属本轮的 Live Compact 切割事件（已按「显示压缩事件」开关过滤）。
   * 与工具行同级渲染在过程流末尾：cut 在 turn_end 发射，是这一轮过程的收尾事件。
   */
  events?: SDKSystemMessage[]
  isStreaming?: boolean
  /** 惰性生成过程项；流式与历史态均渲染完整内容。 */
  renderChildren: () => React.ReactNode
  // 该过程组是否为整条消息的末尾项：是则流式中保留最后一段为正常显示，
  // 否则（最终答案已作为后续兄弟块外置）整组统一弱化。
  isMessageTail?: boolean
  /** 中断或失败轮次的状态标注；存在时过程保持展开，便于用户回看发生了什么。 */
  statusLabel?: string
  /** 该轮在本次渲染时已结束（用于区分流式与历史态的状态标注）。 */
  isTurnTerminal?: boolean
}

const MAX_PROCESS_GROUP_ICONS = 4
const PROCESS_GROUP_VIEWPORT_HEIGHT = 320
const PROCESS_GROUP_LIVE_CHILD_WINDOW = 4
const PROCESS_GROUP_COLLAPSE_DURATION_MS = 500
const PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS = 900
const PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3
const PROGRESS_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

interface IndexedContentBlock {
  block: SDKContentBlock
  index: number
}

type AssistantTurnRenderItem =
  | { type: 'block'; item: IndexedContentBlock }
  | {
      type: 'process-group'
      items: IndexedContentBlock[]
      /** 随该过程组一起展示的切割事件（时间上位于过程末尾）。 */
      events: SDKSystemMessage[]
    }

interface BuildAssistantTurnRenderItemsOptions {
  isStreaming?: boolean
  /** 本轮切割事件；调用方在「显示压缩事件」关闭时传空数组。 */
  events?: SDKSystemMessage[]
}

function getTrailingTextStartIndex(blocks: SDKContentBlock[]): number | null {
  const lastBlock = blocks[blocks.length - 1]
  if (lastBlock?.type !== 'text') return null

  let finalStartIndex = blocks.length - 1
  while (finalStartIndex > 0 && blocks[finalStartIndex - 1]?.type === 'text') {
    finalStartIndex -= 1
  }
  return finalStartIndex
}

export function buildAssistantTurnRenderItems(
  blocks: SDKContentBlock[],
  options: BuildAssistantTurnRenderItemsOptions = {},
): AssistantTurnRenderItem[] {
  const events = options.events ?? []
  if (blocks.length === 0) {
    // 少数轮次只有切割事件没有内容块（例如自动唤醒后立刻 turn_end）：仍要在过程流里留痕。
    return events.length > 0 ? [buildProcessGroupItem([], events)] : []
  }

  // 只要流式末尾出现 text，就按常规消息布局直接展示。若 Agent 之后继续调用工具，
  // text 不再位于末尾，会自动回归过程组，避免把中间状态误认为最终答案。
  const hasProcessBlock = blocks.some((block) => block.type === 'tool_use' || block.type === 'thinking')
  const trailingTextStartIndex = getTrailingTextStartIndex(blocks)
  const canSplitStreamingFinalOutput = options.isStreaming
    && hasProcessBlock
    && trailingTextStartIndex !== null
    && trailingTextStartIndex > 0

  if (options.isStreaming && hasProcessBlock && !canSplitStreamingFinalOutput) {
    return buildProcessGroupItems(blocks, events)
  }

  if (trailingTextStartIndex === null) {
    return buildProcessGroupItems(blocks, events)
  }

  const finalBlocks: AssistantTurnRenderItem[] = []
  for (let index = trailingTextStartIndex; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    finalBlocks.push({ type: 'block', item: { block, index } })
  }

  if (trailingTextStartIndex === 0) {
    // 整轮只有最终回答块：切割事件仍需一个过程组承载，否则事件在界面上丢失。
    if (events.length === 0) return finalBlocks
    const eventItems = buildProcessGroupItems([], events)
    return options.isStreaming ? [...eventItems, ...finalBlocks] : [...finalBlocks, ...eventItems]
  }

  const processItems = buildProcessGroupItems(blocks.slice(0, trailingTextStartIndex), events)

  // 终态：最终回复独立在前，一行过程摘要收尾；流式中仍保留「过程在上、实时回答在下」的阅读顺序。
  if (!options.isStreaming) return [...finalBlocks, ...processItems]

  return [...processItems, ...finalBlocks]
}

function buildProcessGroupItem(
  blocks: SDKContentBlock[],
  events: SDKSystemMessage[],
): AssistantTurnRenderItem {
  return {
    type: 'process-group',
    items: blocks.map((block, index) => ({ block, index })),
    events,
  }
}

function buildProcessGroupItems(
  blocks: SDKContentBlock[],
  events: SDKSystemMessage[] = [],
): AssistantTurnRenderItem[] {
  return [buildProcessGroupItem(blocks, events)]
}

/**
 * Reuse the previous array when streaming only changes a sibling block, such as
 * an already-externalized final text block. Delta updates replace changed block
 * objects immutably, so reference identity is enough to detect process changes.
 */
function stabilizeProcessBlockReferences(
  previous: SDKContentBlock[],
  next: SDKContentBlock[],
): SDKContentBlock[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < next.length; index++) {
    if (previous[index] !== next[index]) return next
  }
  return previous
}

function buildProcessGroupSummary(blocks: SDKContentBlock[], events: SDKSystemMessage[] = []): string {
  let toolCount = 0
  let messageCount = 0

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolCount += 1
    } else if (block.type === 'thinking' || block.type === 'text') {
      messageCount += 1
    }
  }

  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (messageCount > 0) parts.push(`${messageCount} 条消息`)
  if (events.length > 0) parts.push(`${events.length} 次压缩`)
  const summary = parts.join('，') || '过程'
  return `执行过程：${summary}`
}

export function buildProcessGroupToolNames(blocks: SDKContentBlock[]): string[] {
  const toolNames: string[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const toolBlock = block as SDKToolUseBlock
    if (seen.has(toolBlock.name)) continue
    seen.add(toolBlock.name)
    toolNames.push(toolBlock.name)
  }

  return toolNames
}

type ProcessGroupDisplayMode = 'collapsed' | 'expanded'

function getProcessChildKey(child: React.ReactNode, index: number): string {
  if (React.isValidElement(child) && child.key != null) return String(child.key)
  return `process-child-${index}`
}

interface StableProcessChildCacheEntry {
  child: React.ReactNode
  snapshot: string
}

function getProcessChildSnapshot(child: React.ReactNode): string | null {
  if (!React.isValidElement(child) || child.type !== React.Fragment) return null
  const fragmentProps = child.props as { children?: React.ReactNode }
  const content = fragmentProps.children
  if (!React.isValidElement(content)) return null
  const contentProps = content.props as { block?: SDKContentBlock }
  const block = contentProps.block
  if (!block || (block.type !== 'text' && block.type !== 'thinking')) return null
  const text = block.type === 'text'
    ? (block as SDKTextBlock).text
    : (block as SDKThinkingBlock).thinking
  return `${block.type}:${text}`
}

const StableProcessChild = React.memo(
  function StableProcessChild({ child }: { child: React.ReactNode }): React.ReactElement {
    return <>{child}</>
  },
  (previous, next) => previous.child === next.child,
)

export function ProcessBlockGroup({ blocks, events = [], isStreaming, renderChildren, isMessageTail = false, statusLabel, isTurnTerminal = false }: ProcessBlockGroupProps): React.ReactElement {
  // 中断或失败的轮次保持展开：用户需要看到停下之前做了什么。
  const keepExpanded = !!statusLabel && isTurnTerminal && !isStreaming
  const initialDisplayMode: ProcessGroupDisplayMode = keepExpanded || isStreaming
    ? 'expanded'
    : 'collapsed'
  const [displayMode, setDisplayMode] = React.useState<ProcessGroupDisplayMode>(initialDisplayMode)
  const [shouldRenderContent, setShouldRenderContent] = React.useState(initialDisplayMode !== 'collapsed')
  const [keepProgressViewport, setKeepProgressViewport] = React.useState(!!isStreaming)
  const [collapseCountdown, setCollapseCountdown] = React.useState<number | null>(null)
  const userToggledRef = React.useRef(false)
  // 跟随状态复用外层对话列表的纯函数（lib/conversation-follow）：follow/detached 两态
  // + 4/96px 滞回 + 滚轮方向判定 + 用户驱动窗口，两层视口行为一致。
  const modeRef = React.useRef<ConversationFollowMode>('follow')
  const userDrivingUntilRef = React.useRef(0)
  const wasStreamingRef = React.useRef(!!isStreaming)
  const autoCollapseTimersRef = React.useRef<number[]>([])
  const contentRef = React.useRef<HTMLDivElement>(null)
  const contentInnerRef = React.useRef<HTMLDivElement>(null)
  const stableChildrenRef = React.useRef(new Map<string, StableProcessChildCacheEntry>())
  const stableProcessBlocksRef = React.useRef(blocks)
  stableProcessBlocksRef.current = stabilizeProcessBlockReferences(stableProcessBlocksRef.current, blocks)
  const stableProcessBlocks = stableProcessBlocksRef.current
  const collapseFrameRef = React.useRef<number | null>(null)
  const [measuredHeight, setMeasuredHeight] = React.useState<number | undefined>(undefined)

  const isContentExpanded = displayMode === 'expanded'
  const shouldShowContent = isContentExpanded || shouldRenderContent
  const visibleChildren = shouldShowContent ? renderChildren() : null

  const clearAutoCollapseTimers = React.useCallback(() => {
    for (const timer of autoCollapseTimersRef.current) window.clearTimeout(timer)
    autoCollapseTimersRef.current = []
  }, [])

  React.useEffect(() => {
    clearAutoCollapseTimers()

    if (keepExpanded) {
      setCollapseCountdown(null)
      setKeepProgressViewport(false)
      setDisplayMode('expanded')
      wasStreamingRef.current = false
      return
    }

    if (isStreaming) {
      setCollapseCountdown(null)
      setKeepProgressViewport(true)
      if (!wasStreamingRef.current) {
        userToggledRef.current = false
        modeRef.current = 'follow'
        userDrivingUntilRef.current = 0
      }
      if (!userToggledRef.current) setDisplayMode('expanded')
      wasStreamingRef.current = true
      return
    }

    const shouldAutoCollapseAfterCompletion = wasStreamingRef.current && !userToggledRef.current
    wasStreamingRef.current = false

    if (!shouldAutoCollapseAfterCompletion) {
      setKeepProgressViewport(false)
      if (!userToggledRef.current) setDisplayMode('collapsed')
      return
    }

    const soundDelayTimer = window.setTimeout(() => {
      setCollapseCountdown(PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS)

      for (let second = PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - 1; second >= 1; second--) {
        const elapsed = (PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - second) * 1000
        autoCollapseTimersRef.current.push(window.setTimeout(() => setCollapseCountdown(second), elapsed))
      }

      autoCollapseTimersRef.current.push(window.setTimeout(() => {
        setCollapseCountdown(null)
        setDisplayMode('collapsed')
        autoCollapseTimersRef.current.push(window.setTimeout(
          () => setKeepProgressViewport(false),
          PROCESS_GROUP_COLLAPSE_DURATION_MS,
        ))
      }, PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS * 1000))
    }, PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS)
    autoCollapseTimersRef.current.push(soundDelayTimer)

    return clearAutoCollapseTimers
  }, [clearAutoCollapseTimers, isStreaming, keepExpanded])

  const markUserDriving = React.useCallback((): void => {
    userDrivingUntilRef.current = Date.now() + USER_DRIVE_WINDOW_MS
  }, [])

  const applyMode = React.useCallback((next: ConversationFollowMode | null): void => {
    if (next && next !== modeRef.current) modeRef.current = next
  }, [])

  const readMetrics = React.useCallback((): FollowScrollMetrics | null => {
    const element = contentRef.current
    if (!element) return null
    return { scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }
  }, [])

  // 内容增长后跟手到底；用户正在滚（驱动窗口内）或已脱离时不抢 scrollTop。
  const forceFollowBottom = React.useCallback((): void => {
    const element = contentRef.current
    const metrics = readMetrics()
    if (!element || !metrics) return
    if (!shouldForceFollowBottom({
      mode: modeRef.current,
      metrics,
      userDrivingUntil: userDrivingUntilRef.current,
      now: Date.now(),
    })) return
    element.scrollTop = element.scrollHeight
  }, [readMetrics])

  React.useLayoutEffect(() => {
    if (!isStreaming || !keepProgressViewport) return
    const content = contentInnerRef.current
    if (!content) return

    const observer = new ResizeObserver(forceFollowBottom)
    observer.observe(content)
    forceFollowBottom()
    return () => observer.disconnect()
  }, [isStreaming, keepProgressViewport, forceFollowBottom])

  React.useLayoutEffect(() => {
    if (isStreaming && keepProgressViewport) forceFollowBottom()
  }, [stableProcessBlocks, isStreaming, keepProgressViewport, forceFollowBottom])

  // 滚动几何判定：回到底（≤4px）重挂，离远（>96px）脱离，中间死区保持原状态。
  const handleProgressScroll = React.useCallback((): void => {
    const metrics = readMetrics()
    if (metrics) applyMode(decideFollowOnScroll(modeRef.current, metrics))
  }, [applyMode, readMetrics])

  // 滚轮是最明确的用户意图：向上滚且离开底部才脱离，向下滚回到底即恢复；
  // 被更内层可滚动子元素（如代码块）消费的滚轮不影响本视口跟随。
  const handleProgressWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    markUserDriving()
    const metrics = readMetrics()
    if (!metrics) return
    const distanceToBottom = getFollowDistance(metrics)
    applyMode(decideFollowOnWheel(modeRef.current, {
      deltaY: event.deltaY,
      distanceToBottom,
      innerViewportOwnsWheel: innerViewportOwnsWheel(event.target, contentRef.current, event.deltaY),
      canScrollDown: distanceToBottom > 0,
    }))
  }, [applyMode, markUserDriving, readMetrics])

  const handleProgressKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (PROGRESS_SCROLL_KEYS.has(event.key)) markUserDriving()
  }, [markUserDriving])

  // 折叠前测量实际高度，用于丝滑的 height 过渡（子元素不 reflow，只裁剪边界）
  React.useEffect(() => {
    if (isContentExpanded) {
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
      setShouldRenderContent(true)
      setMeasuredHeight(undefined)
      return
    }

    // 折叠时：先测量当前高度，触发 height 过渡动画，动画结束后卸载 DOM
    const el = contentRef.current
    if (el) {
      const h = el.clientHeight
      setMeasuredHeight(h)
      collapseFrameRef.current = requestAnimationFrame(() => {
        collapseFrameRef.current = null
        setMeasuredHeight(0)
      })
    }

    const timer = window.setTimeout(() => setShouldRenderContent(false), PROCESS_GROUP_COLLAPSE_DURATION_MS)
    return () => {
      window.clearTimeout(timer)
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
    }
  }, [isContentExpanded])

  const summary = React.useMemo(
    () => buildProcessGroupSummary(blocks, events),
    [blocks, events],
  )
  const toolNames = React.useMemo(() => buildProcessGroupToolNames(blocks), [blocks])
  const visibleToolNames = toolNames.slice(0, MAX_PROCESS_GROUP_ICONS)
  const hiddenToolCount = Math.max(0, toolNames.length - visibleToolNames.length)

  // 只让最近几项参与高频更新；旧项保留在 DOM 中供用户滚动查看，但冻结其 React 子树。
  const renderContentChildren = (): React.ReactNode => {
    const childArray = React.Children.toArray(visibleChildren)
    const liveStart = Math.max(0, childArray.length - PROCESS_GROUP_LIVE_CHILD_WINDOW)
    const activeKeys = new Set<string>()

    const rendered = childArray.map((child, i) => {
      const key = getProcessChildKey(child, i)
      activeKeys.add(key)
      const cachedEntry = stableChildrenRef.current.get(key)
      const snapshot = getProcessChildSnapshot(child)
      const shouldFreeze = !!isStreaming && i < liveStart && snapshot !== null
      const stableChild = shouldFreeze && cachedEntry?.snapshot === snapshot
        ? cachedEntry.child
        : child
      if (!shouldFreeze || !cachedEntry || cachedEntry.snapshot !== snapshot) {
        stableChildrenRef.current.set(key, { child, snapshot: snapshot ?? '' })
      }

      const isLast = i === childArray.length - 1
      const dimmed = isStreaming && !(isMessageTail && isLast)
      return (
        <div key={key} className={cn(dimmed && 'opacity-80')}>
          <StableProcessChild child={stableChild} />
        </div>
      )
    })

    for (const key of stableChildrenRef.current.keys()) {
      if (!activeKeys.has(key)) stableChildrenRef.current.delete(key)
    }
    return rendered
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className={cn(
          'flex max-w-full items-center gap-2 py-0.5 text-left transition-opacity group',
          'hover:opacity-70',
        )}
        onClick={() => {
          userToggledRef.current = true
          clearAutoCollapseTimers()
          setCollapseCountdown(null)
          if (!isStreaming) setKeepProgressViewport(false)
          setDisplayMode((previous) => previous === 'collapsed' ? 'expanded' : 'collapsed')
        }}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/40 transition-transform duration-150',
            isContentExpanded && 'rotate-90',
          )}
        />
        <span className="min-w-0 truncate text-[14px] text-muted-foreground">{summary}</span>
        {statusLabel && (
          <span className="shrink-0 rounded-full border border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground/80">
            {statusLabel}
          </span>
        )}
        {collapseCountdown !== null && (
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground/50">
            （{collapseCountdown}）
          </span>
        )}
        {visibleToolNames.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground/60">
            {visibleToolNames.map((toolName) => {
              const ToolIcon = getToolIcon(toolName)
              return (
                <ToolIcon
                  key={toolName}
                  className="size-3.5"
                  aria-label={getToolDisplayName(toolName)}
                />
              )
            })}
            {hiddenToolCount > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground/60">
                +{hiddenToolCount}
              </span>
            )}
          </span>
        )}
        {events.length > 0 && (
          <Scissors
            className="size-3.5 shrink-0 text-muted-foreground/60"
            aria-label="上下文压缩"
          />
        )}
      </button>

      {shouldRenderContent && (
        <div
          ref={contentRef}
          data-agent-history-selection-excluded={isContentExpanded ? undefined : 'true'}
          className={cn(
            'overflow-hidden focus:outline-none',
            keepProgressViewport && 'overflow-y-auto overscroll-contain scrollbar-none',
          )}
          tabIndex={keepProgressViewport ? 0 : undefined}
          onScroll={keepProgressViewport ? handleProgressScroll : undefined}
          onPointerDown={keepProgressViewport ? markUserDriving : undefined}
          onWheel={keepProgressViewport ? handleProgressWheel : undefined}
          onTouchStart={keepProgressViewport ? markUserDriving : undefined}
          onKeyDown={keepProgressViewport ? handleProgressKeyDown : undefined}
          style={{
            maxHeight: keepProgressViewport ? `${PROCESS_GROUP_VIEWPORT_HEIGHT}px` : undefined,
            height: measuredHeight !== undefined ? `${measuredHeight}px` : 'auto',
            opacity: isContentExpanded ? 1 : 0,
            transition: measuredHeight !== undefined
              ? `height ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`
              : `opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`,
          }}
        >
          <div ref={contentInnerRef} className="space-y-2">
            {renderContentChildren()}
            {events.map((event, index) => (
              <div key={`spine-cut-${index}`} className={cn(isStreaming && 'opacity-80')}>
                <SpineCutProcessRow message={event} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
