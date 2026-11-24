/**
 * ConversationFollowProvider — 在 Conversation（StickToBottom）外面套一层应用层的跟随状态。
 *
 * 库只暴露 `isAtBottom` / `escapedFromLock` 两个内部标志和一个会被动画状态早退的
 * `scrollToBottom`，不足以表达「用户正在读上面的内容」这个意图。判定逻辑与阈值都在
 * `@/lib/conversation-follow` 里（纯函数、可单测），这里只负责接 DOM 事件。
 *
 * 必须放在 `<Conversation>` 内部使用（要读 `useStickToBottomContext`）。
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from 'lucide-react'
import * as React from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import {
  USER_DRIVE_WINDOW_MS,
  decideFollowOnScroll,
  decideFollowOnWheel,
  getFollowDistance,
  innerViewportOwnsWheel,
  shouldForceFollowBottom,
  type ConversationFollowMode,
} from '@/lib/conversation-follow'

export interface ConversationFollowValue {
  /** 当前跟随意图；`detached` 表示用户主动离开底部，内容增长不再跟手 */
  mode: ConversationFollowMode
  /** 显式恢复跟随：滚到底并重新武装库的内部跟随标志 */
  resume: () => void
}

const ConversationFollowContext = React.createContext<ConversationFollowValue | null>(null)
ConversationFollowContext.displayName = 'ConversationFollowContext'

/** 取应用层跟随状态；不在 ConversationFollowProvider 内时返回 null，调用方退回库的 isAtBottom */
export function useConversationFollow(): ConversationFollowValue | null {
  return React.useContext(ConversationFollowContext)
}

export function ConversationFollowProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottomContext()
  const [mode, setMode] = React.useState<ConversationFollowMode>('follow')
  const modeRef = React.useRef<ConversationFollowMode>('follow')
  const userDrivingUntilRef = React.useRef(0)

  const applyMode = React.useCallback((next: ConversationFollowMode | null): void => {
    if (!next || next === modeRef.current) return
    modeRef.current = next
    setMode(next)
  }, [])

  const markUserDriving = React.useCallback((): void => {
    userDrivingUntilRef.current = Date.now() + USER_DRIVE_WINDOW_MS
  }, [])

  const resume = React.useCallback((): void => {
    userDrivingUntilRef.current = 0
    applyMode('follow')
    // 不能传 preserveScrollPosition：库只在 !preserveScrollPosition 时才 setIsAtBottom(true)
    // （useStickToBottom.js:135-136），那是它自己的跟随开关，要一起重新武装。
    void scrollToBottom({ animation: 'instant' })
  }, [applyMode, scrollToBottom])

  // 滚动容器是 StickToBottom 自己的 div，整个生命周期内不换；effect 在 ref 挂好之后运行。
  React.useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const metrics = () => ({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    })

    const handleScroll = (): void => {
      applyMode(decideFollowOnScroll(modeRef.current, metrics()))
    }

    const handleWheel = (event: WheelEvent): void => {
      markUserDriving()
      applyMode(
        decideFollowOnWheel(modeRef.current, {
          deltaY: event.deltaY,
          distanceToBottom: getFollowDistance(metrics()),
          innerViewportOwnsWheel: innerViewportOwnsWheel(event.target, element, event.deltaY),
          canScrollDown: element.scrollHeight - element.clientHeight - element.scrollTop > 0,
        }),
      )
    }

    // 拖动滚动条、点击轨道都算用户接管滚动（拖动不产生 wheel，库因此漏掉这部分意图）
    const handlePointerDown = (): void => {
      markUserDriving()
    }

    element.addEventListener('scroll', handleScroll, { passive: true })
    element.addEventListener('wheel', handleWheel, { passive: true })
    element.addEventListener('pointerdown', handlePointerDown, { passive: true })

    // 内容增长时直接纠正 scrollTop，不进库的动画队列：动画存在时库的 scrollToBottom 会早退，
    // 而我们要的是「跟随时始终贴底」，同时也不与用户正在进行的滚动抢手。
    let observer: ResizeObserver | null = null
    const content = contentRef.current
    if (content) {
      observer = new ResizeObserver(() => {
        if (
          !shouldForceFollowBottom({
            mode: modeRef.current,
            metrics: metrics(),
            userDrivingUntil: userDrivingUntilRef.current,
            now: Date.now(),
          })
        ) {
          return
        }
        element.scrollTop = element.scrollHeight
      })
      observer.observe(content)
    }

    return () => {
      element.removeEventListener('scroll', handleScroll)
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('pointerdown', handlePointerDown)
      observer?.disconnect()
    }
  }, [applyMode, contentRef, markUserDriving, scrollRef])

  const value = React.useMemo<ConversationFollowValue>(() => ({ mode, resume }), [mode, resume])

  return <ConversationFollowContext.Provider value={value}>{children}</ConversationFollowContext.Provider>
}

/**
 * 脱离跟随时给一个明确的「回到底部」入口。
 *
 * 用零高度的 `sticky` 盒子贴在滚动视口底边：既不占额外版面（不会把内容顶上去），
 * 也不用 `fixed` + 魔法 bottom 偏移（不会藏在输入框后面）。
 */
export function ConversationFollowButton({ className }: { className?: string }): React.ReactElement | null {
  const follow = useConversationFollow()
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const detached = follow ? follow.mode === 'detached' : !isAtBottom
  if (!detached) return null

  return (
    <div className="sticky bottom-3 z-10 h-0 shrink-0 overflow-visible">
      <Button
        aria-label="回到底部并继续跟随"
        className={cn(
          'absolute bottom-0 right-0 size-9 rounded-[17px]',
          'bg-card shadow-sm hover:bg-accent/80',
          className,
        )}
        onClick={() => {
          if (follow) {
            follow.resume()
            return
          }
          void scrollToBottom({ animation: 'instant' })
        }}
        type="button"
        variant="ghost"
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    </div>
  )
}
