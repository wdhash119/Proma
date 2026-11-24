/**
 * 对话列表的自动跟随状态（纯函数，无 DOM），用来取代 use-stick-to-bottom 的内置跟随判定。
 *
 * 为什么要在应用层管：库把「是否跟随」放进内部 `state.isAtBottom`，应用既读不到真实意图，
 * 也没法可靠地重新武装它，实测有三个后果（use-stick-to-bottom 1.1.6）：
 *
 * 1. 判定窗口是写死的 70px（`STICK_TO_BOTTOM_OFFSET_PX`）。距底 0～70px 都算「在底部」，
 *    于是向上滚 60px 会显示「回到底部」按钮，但动画仍在跑、`state.animation` 非空时
 *    `scrollToBottom` 直接 return（`useStickToBottom.js:160-163`），按钮点了没反应。
 * 2. 滚动事件要过 `scan()` 里的 32ms 采样队列，一旦 `state.resizeDifference` 非零就整段被
 *    吞掉（`:255-258`），用户滚轮产生的那次「已经离开底部」的分类当场丢失，跟随状态留在
 *    「在底部」。流式期间 ResizeObserver 几乎每帧都在触发，这段吞分类的窗口会反复出现。
 * 3. 重新武装只有两条路：滚轮向上累计超过 70px（`:225-238`），或滚到底让 `handleScroll` 里
 *    `distance === 0` 时 `setIsAtBottom(true)`（`:314-320`）。鼠标拖动滚动条恰好两条都不满足
 *    ——拖动不产生 wheel，落点又常差几十 px，于是「拖到底也不恢复」。
 *
 * 这里把跟随意图显式化成两态，判定全部基于几何而不是内部标志：
 * - `follow`：内容增长时跟手到底。
 * - `detached`：用户在读上面的内容，不再跟手；滚回距底 4px 内，或点「回到底部」才恢复。
 * 退出跟随的阈值（96px）刻意大于库的 70px，避免应用与库在 70px 附近来回改状态。
 *
 * 同文件之外的 `ProcessBlockGroup`（进度条内层视口）直接复用本文件的纯函数
 * （decideFollowOnScroll / decideFollowOnWheel / shouldForceFollowBottom / innerViewportOwnsWheel），
 * 两层视口的跟随行为保持一致；内层不再自写单布尔「意图即脱离 + 距底重挂」逻辑。
 */

export type ConversationFollowMode = 'follow' | 'detached'

/** 距底不超过这个距离就算「已经到底」，重新武装跟随 */
export const FOLLOW_REARM_EPSILON_PX = 4

/** 距底超过这个距离就判定用户离开底部；必须大于库内的 70px，避免两层判定互相覆盖 */
export const FOLLOW_DETACH_PX = 96

/** 这段时间内不跟手，避免自动纠正和用户正在进行的滚动互相抢 scrollTop */
export const USER_DRIVE_WINDOW_MS = 400

/** 跟手时距底超过这个距离才硬纠正，避免在目标附近反复写入 scrollTop */
export const FORCE_SNAP_EPSILON_PX = 2

/** 滚动几何快照 */
export interface FollowScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** 用户一次滚轮输入的判定结果 */
export interface FollowWheelIntent {
  /** 滚轮增量，向上为负 */
  deltaY: number
  /** 距底距离 */
  distanceToBottom: number
  /** 这次滚轮实际由更内层的可滚动元素消费（进度条视口、代码块等），不该影响外层跟随 */
  innerViewportOwnsWheel: boolean
  /** 内容是否还能向下滚（短消息里 wheel-up 没有「离开底部」的语义） */
  canScrollDown: boolean
}

/** 距容器底部的剩余距离 */
export function getFollowDistance(metrics: FollowScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

/**
 * 一次原生滚动带来的跟随变化：回到底部即恢复，离远即脱离，中间保持不变。
 *
 * @returns 新状态；null 表示不变
 */
export function decideFollowOnScroll(
  mode: ConversationFollowMode,
  metrics: FollowScrollMetrics,
): ConversationFollowMode | null {
  const distance = getFollowDistance(metrics)
  if (distance <= FOLLOW_REARM_EPSILON_PX) {
    return mode === 'follow' ? null : 'follow'
  }
  if (distance > FOLLOW_DETACH_PX) {
    return mode === 'detached' ? null : 'detached'
  }
  return null
}

/**
 * 一次滚轮输入带来的跟随变化。滚轮是最明确的用户意图，不需要像库那样累计 70px 才认：
 * 向上滚立即脱离，向下滚回到底立即恢复。
 *
 * @returns 新状态；null 表示不变
 */
export function decideFollowOnWheel(
  mode: ConversationFollowMode,
  intent: FollowWheelIntent,
): ConversationFollowMode | null {
  if (intent.innerViewportOwnsWheel) return null
  if (intent.deltaY < 0) {
    if (!intent.canScrollDown) return null
    return intent.distanceToBottom > FOLLOW_REARM_EPSILON_PX && mode === 'follow' ? 'detached' : null
  }
  if (intent.deltaY > 0 && intent.distanceToBottom <= FOLLOW_REARM_EPSILON_PX) {
    return mode === 'detached' ? 'follow' : null
  }
  return null
}

/**
 * 内容增长后是否要把视图硬纠正到底部。用户正在滚（`userDrivingUntil` 未过期）时不跟手，
 * 这是修复第 ② 项的关键：不再靠动画去追一个正在被用户拖走的 viewport。
 */
export function shouldForceFollowBottom(params: {
  mode: ConversationFollowMode
  metrics: FollowScrollMetrics
  userDrivingUntil: number
  now: number
}): boolean {
  if (params.mode !== 'follow') return false
  if (params.now < params.userDrivingUntil) return false
  return getFollowDistance(params.metrics) > FORCE_SNAP_EPSILON_PX
}

/** 单个元素的滚动状态快照（computed overflowY + 几何），供滚轮归属判定 */
export interface FollowElementScrollState {
  overflowY: string
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/**
 * 这个元素能否沿滚轮方向继续滚（即会不会把滚轮消费掉）。
 * 纯函数，与 DOM 遍历分开，便于单测。
 */
export function elementOwnsWheel(state: FollowElementScrollState, deltaY: number): boolean {
  const scrollable = state.overflowY === 'auto' || state.overflowY === 'scroll' || state.overflowY === 'overlay'
  if (!scrollable || state.scrollHeight - state.clientHeight <= 0) return false
  const distance = state.scrollHeight - state.clientHeight - state.scrollTop
  return deltaY < 0 ? state.scrollTop > 0 : distance > 0
}

/**
 * 从滚轮目标向上找最近的可滚动祖先，并判断它能不能沿滚轮方向继续滚。
 * 用来判断这次滚轮是被更内层的视口（进度条、报错 `<pre>`）消费，还是落到对话容器本身。
 *
 * @param target 滚轮事件目标
 * @param outer 对话容器；走到它为止，不再向上
 * @param deltaY 滚轮增量，向上为负
 */
export function innerViewportOwnsWheel(
  target: EventTarget | null,
  outer: HTMLElement | null,
  deltaY: number,
): boolean {
  if (!(target instanceof Node) || !outer) return false
  let node: Node | null = target.parentElement ?? (target === outer ? outer : null)
  while (node && node !== outer) {
    if (node instanceof HTMLElement) {
      const owns = elementOwnsWheel(
        {
          overflowY: window.getComputedStyle(node).overflowY,
          scrollTop: node.scrollTop,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        },
        deltaY,
      )
      if (owns) return true
    }
    node = node.parentElement
  }
  return false
}
