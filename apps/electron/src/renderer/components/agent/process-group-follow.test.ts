/**
 * 执行过程容器（ProcessBlockGroup）内层视口的自动跟随接线。
 *
 * 回归背景：内层曾用单布尔 followLatestRef——「任意意图事件（pointerdown/wheel/touch）即脱离
 * + 距底 24px 即重挂 + 无用户驱动抑制」，导致两类故障：
 *   ① 自动滚动失效：点击工具行、向下滚到底后再滚一点都会误脱离，且流式期间底部后退难以重挂；
 *   ② 吸附力过强：小幅上滚（≤24px）被 onScroll 立即重挂并动画拽回底部。
 * 修复：复用外层对话列表的纯函数（lib/conversation-follow），follow/detached 两态 + 4/96px 滞回
 * + 滚轮方向判定 + 用户驱动窗口。本测试锁定接线，防止回流到旧的单布尔逻辑。
 *
 * bun 测试环境没有 DOM，沿用仓库源码断言模式（同 live-compact-wiring.test.ts）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'ProcessBlockGroup.tsx'), 'utf8')

describe('执行过程容器：跟随状态复用外层纯函数', () => {
  test('Given 内层视口 When 检查导入 Then 复用 conversation-follow 的几何判定而非自写阈值', () => {
    expect(source).toContain("from '@/lib/conversation-follow'")
    expect(source).toContain('decideFollowOnScroll')
    expect(source).toContain('decideFollowOnWheel')
    expect(source).toContain('shouldForceFollowBottom')
    expect(source).toContain('innerViewportOwnsWheel')
    expect(source).toContain('USER_DRIVE_WINDOW_MS')
    // 旧的单布尔与写死 24px 阈值必须移除。
    expect(source).not.toContain('followLatestRef')
    expect(source).not.toContain('PROCESS_GROUP_FOLLOW_BOTTOM_THRESHOLD')
    expect(source).not.toContain('isProgressViewportAtBottom')
  })

  test('Given 跟随状态 When 检查 Then 是 follow/detached 两态而非单布尔', () => {
    expect(source).toContain("React.useRef<ConversationFollowMode>('follow')")
    expect(source).toContain('userDrivingUntilRef')
  })
})

describe('执行过程容器：意图事件不再无条件脱离', () => {
  test('Given pointerdown/touchstart When 检查 Then 只标记用户驱动，不脱离跟随', () => {
    expect(source).toContain('onPointerDown={keepProgressViewport ? markUserDriving : undefined}')
    expect(source).toContain('onTouchStart={keepProgressViewport ? markUserDriving : undefined}')
    // 旧的「任意意图即脱离」handler 必须移除。
    expect(source).not.toContain('handleProgressScrollIntent')
  })

  test('Given 滚轮 When 检查 Then 按方向与距底判定（向上离开才脱离、向下到底恢复）', () => {
    expect(source).toContain('onWheel={keepProgressViewport ? handleProgressWheel : undefined}')
    const wheelBody = source.slice(source.indexOf('const handleProgressWheel'), source.indexOf('const handleProgressKeyDown'))
    expect(wheelBody).toContain('markUserDriving()')
    expect(wheelBody).toContain('decideFollowOnWheel')
    expect(wheelBody).toContain('deltaY: event.deltaY')
    expect(wheelBody).toContain('innerViewportOwnsWheel(event.target, contentRef.current, event.deltaY)')
    expect(wheelBody).toContain('canScrollDown: distanceToBottom > 0')
  })

  test('Given 原生滚动 When 检查 Then 用滞回几何判定（4px 重挂 / 96px 脱离 / 死区保持）', () => {
    const scrollBody = source.slice(source.indexOf('const handleProgressScroll'), source.indexOf('const handleProgressWheel'))
    expect(scrollBody).toContain('decideFollowOnScroll(modeRef.current, metrics)')
    // 不再「距底即重挂并立刻 scrollToLatest」——那是吸附力过强的根源。
    expect(scrollBody).not.toContain('scrollToLatest')
  })
})

describe('执行过程容器：内容增长纠正避开用户驱动', () => {
  test('Given ResizeObserver When 检查 Then 经 shouldForceFollowBottom 门控，不抢用户 scrollTop', () => {
    expect(source).toContain('new ResizeObserver(forceFollowBottom)')
    const forceBody = source.slice(source.indexOf('const forceFollowBottom'), source.indexOf('React.useLayoutEffect'))
    expect(forceBody).toContain('shouldForceFollowBottom')
    expect(forceBody).toContain('userDrivingUntil: userDrivingUntilRef.current')
    expect(forceBody).toContain('element.scrollTop = element.scrollHeight')
    // 旧的 rAF 平滑动画（会与用户滚动抢手）必须移除。
    expect(source).not.toContain('smoothScrollTargetRef')
    expect(source).not.toContain('scrollFrameRef')
    expect(source).not.toContain('requestAnimationFrame(advanceScroll)')
  })

  test('Given 新一轮流式开始 When 检查 Then 跟随重置为 follow 且清空驱动窗口', () => {
    expect(source).toContain("modeRef.current = 'follow'")
    expect(source).toContain('userDrivingUntilRef.current = 0')
  })
})