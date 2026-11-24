import { describe, expect, test } from 'bun:test'
import {
  FOLLOW_DETACH_PX,
  FOLLOW_REARM_EPSILON_PX,
  FORCE_SNAP_EPSILON_PX,
  decideFollowOnScroll,
  decideFollowOnWheel,
  getFollowDistance,
  shouldForceFollowBottom,
  type FollowScrollMetrics,
  type FollowWheelIntent,
} from './conversation-follow'

/** 造一份滚动几何：内容高 2000、视口 800，scrollTop 由「距底多远」反推 */
function metricsAt(distanceToBottom: number): FollowScrollMetrics {
  const scrollHeight = 2000
  const clientHeight = 800
  return { scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight - distanceToBottom }
}

/** 造一份滚轮输入；默认落到对话容器本身、内容还能下滚 */
function wheelAt(patch: Partial<FollowWheelIntent>): FollowWheelIntent {
  return {
    deltaY: 0,
    distanceToBottom: 0,
    innerViewportOwnsWheel: false,
    canScrollDown: true,
    ...patch,
  }
}

describe('跟随状态的几何判定', () => {
  test('Given scrollTop 已到底 When 计算距底距离 Then 距离为 0', () => {
    expect(getFollowDistance({ scrollTop: 1200, clientHeight: 800, scrollHeight: 2000 })).toBe(0)
  })

  test('Given scrollTop 超过最大滚动量 When 计算距底距离 Then 钳到 0 不出现负数', () => {
    expect(getFollowDistance({ scrollTop: 1500, clientHeight: 800, scrollHeight: 2000 })).toBe(0)
  })

  test('Given 距底 100px When 计算距底距离 Then 返回 100', () => {
    expect(getFollowDistance(metricsAt(100))).toBe(100)
  })
})

describe('原生滚动事件的跟随判定', () => {
  test('Given 已脱离且滚回距底 4px 内 When 处理滚动 Then 恢复跟随', () => {
    expect(decideFollowOnScroll('detached', metricsAt(FOLLOW_REARM_EPSILON_PX))).toBe('follow')
  })

  test('Given 正在跟随 When 滚回到底 Then 返回 null 不重复触发渲染', () => {
    expect(decideFollowOnScroll('follow', metricsAt(0))).toBeNull()
  })

  test('Given 正在跟随 When 滚到距底超过脱离阈值 Then 判定脱离', () => {
    expect(decideFollowOnScroll('follow', metricsAt(FOLLOW_DETACH_PX))).toBeNull()
    expect(decideFollowOnScroll('follow', metricsAt(FOLLOW_DETACH_PX + 1))).toBe('detached')
  })

  test('Given 库的 70px 近底带 When 处理滚动 Then 不算脱离，避免与库反复互相覆盖', () => {
    // 70px 正好是库内部 STICK_TO_BOTTOM_OFFSET_PX，落在它里面的滚动不该翻转应用层意图
    expect(decideFollowOnScroll('follow', metricsAt(70))).toBeNull()
    expect(decideFollowOnScroll('detached', metricsAt(70))).toBeNull()
  })

  test('Given 脱离阈值与重挂阈值 When 对比 Then 脱离阈值明显大于库的 70px 且大于重挂容差', () => {
    expect(FOLLOW_DETACH_PX).toBeGreaterThan(70)
    expect(FOLLOW_DETACH_PX).toBeGreaterThan(FOLLOW_REARM_EPSILON_PX)
  })
})

describe('滚轮输入的跟随判定', () => {
  test('Given 滚轮被更内层视口消费 When 判定 Then 不影响外层跟随', () => {
    expect(decideFollowOnWheel('follow', wheelAt({ deltaY: -120, distanceToBottom: 400, innerViewportOwnsWheel: true }))).toBeNull()
    expect(decideFollowOnWheel('detached', wheelAt({ deltaY: -120, distanceToBottom: 400, innerViewportOwnsWheel: true }))).toBeNull()
  })

  test('Given 跟随时向上滚且视图已经离开底部 When 判定 Then 立即脱离', () => {
    expect(decideFollowOnWheel('follow', wheelAt({ deltaY: -100, distanceToBottom: 100 }))).toBe('detached')
  })

  test('Given 贴着底部向上滚的第一下 When 判定 Then 不脱离，等真实滚动发生再由滚动事件判定', () => {
    expect(decideFollowOnWheel('follow', wheelAt({ deltaY: -100, distanceToBottom: 0 }))).toBeNull()
  })

  test('Given 内容不足一屏 When 向上滚 Then 不脱离，短消息没有「离开底部」语义', () => {
    expect(decideFollowOnWheel('follow', wheelAt({ deltaY: -100, distanceToBottom: 0, canScrollDown: false }))).toBeNull()
  })

  test('Given 已脱离 When 向下滚回到底 Then 恢复跟随', () => {
    expect(decideFollowOnWheel('detached', wheelAt({ deltaY: 120, distanceToBottom: 0 }))).toBe('follow')
  })

  test('Given 已脱离 When 向下滚但还没到底 Then 保持脱离', () => {
    expect(decideFollowOnWheel('detached', wheelAt({ deltaY: 120, distanceToBottom: 300 }))).toBeNull()
  })

  test('Given 正在跟随 When 向下滚回到底 Then 返回 null 不重复触发渲染', () => {
    expect(decideFollowOnWheel('follow', wheelAt({ deltaY: 120, distanceToBottom: 0 }))).toBeNull()
  })
})

describe('内容增长后的跟手纠正', () => {
  test('Given 已脱离 When 内容增长 Then 不跟手，这是「上滚读历史不被拽回去」的关键', () => {
    expect(
      shouldForceFollowBottom({ mode: 'detached', metrics: metricsAt(400), userDrivingUntil: 0, now: 1000 }),
    ).toBe(false)
  })

  test('Given 用户正在滚动 When 内容增长 Then 400ms 内不跟手，不与用户抢 scrollTop', () => {
    expect(
      shouldForceFollowBottom({ mode: 'follow', metrics: metricsAt(400), userDrivingUntil: 1400, now: 1000 }),
    ).toBe(false)
  })

  test('Given 跟随时距底超过纠正容差 When 内容增长 Then 立即纠正到底', () => {
    expect(
      shouldForceFollowBottom({
        mode: 'follow',
        metrics: metricsAt(FORCE_SNAP_EPSILON_PX + 1),
        userDrivingUntil: 0,
        now: 1000,
      }),
    ).toBe(true)
  })

  test('Given 跟随时已在目标容差内 When 内容增长 Then 不再写 scrollTop', () => {
    expect(
      shouldForceFollowBottom({ mode: 'follow', metrics: metricsAt(FORCE_SNAP_EPSILON_PX), userDrivingUntil: 0, now: 1000 }),
    ).toBe(false)
  })
})

// innerViewportOwnsWheel 依赖 Node/getComputedStyle，bun 测试环境没有 DOM，
// 该分支由内嵌浏览器与真机验收覆盖，这里不做假 DOM 断言。
