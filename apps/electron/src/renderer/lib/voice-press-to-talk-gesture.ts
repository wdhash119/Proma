/**
 * 「按住说话」手势消费与 click 抑制判定
 *
 * 长按越过阈值并实际发起 start 时就消费本次手势：此后 pointerup 一律 arm 抑制，
 * 松手后浏览器补发的原生 click 不再触发普通 toggle。
 * 这里刻意不依赖 DOM，纯函数 + 显式时间戳，便于按控制器测试风格覆盖
 * 「deferred start → pointerup → click → resolve(true/false)」的时序。
 */

/** 抑制窗口：拖出按钮后松手不产生 click，超过该时间后自动失效。 */
const PRESS_TO_TALK_CLICK_SUPPRESSION_WINDOW_MS = 800

/** 一次按下手势的可变状态；由调用方按自己的 ref/state 持有。 */
interface PressToTalkGestureState {
  /** 本次手势是否已被长按消费（越过阈值并发起 start，或选中文本时主动消费）。 */
  activated: boolean
  /** click 抑制截止时间戳；0 表示无需抑制。 */
  suppressUntil: number
}

export function createPressToTalkGestureState(): PressToTalkGestureState {
  return { activated: false, suppressUntil: 0 }
}

/** 新的按下开始：清空上一次手势的消费与抑制状态。 */
export function beginPressGesture(state: PressToTalkGestureState): void {
  state.activated = false
  state.suppressUntil = 0
}

/** 消费手势：必须在 start IPC 的 await 之前调用，保证迟到 resolve 也不漏抑制。 */
export function consumePressGesture(state: PressToTalkGestureState): void {
  state.activated = true
}

/** 松手/取消：已消费的手势在同一时刻 arm 一个抑制窗口。 */
export function endPressGesture(state: PressToTalkGestureState, now: number): void {
  if (state.activated) state.suppressUntil = now + PRESS_TO_TALK_CLICK_SUPPRESSION_WINDOW_MS
}

/** 查询并消费一次抑制；窗口内有且只抑制一次 click。 */
export function shouldSuppressPressToTalkClick(state: PressToTalkGestureState, now: number): boolean {
  if (now >= state.suppressUntil) return false
  state.suppressUntil = 0
  return true
}
