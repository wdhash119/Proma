/**
 * useVoicePressToTalk — 输入框麦克风按钮的「按住说话」绑定
 *
 * 只有语音输入与「按住说话」都开启时才可用；用户按住按钮超过阈值后开始录音，松开结束。
 * 移动鼠标、窗口失焦、按下 Esc 都会取消尚未开始的会话，避免误触发录音。
 */

import * as React from 'react'
import { PressToTalkController } from '@/lib/voice-press-to-talk'
import {
  beginPressGesture,
  consumePressGesture,
  createPressToTalkGestureState,
  endPressGesture,
  shouldSuppressPressToTalkClick,
} from '@/lib/voice-press-to-talk-gesture'
import { VOICE_DICTATION_SETTINGS_CHANGED_EVENT } from '@/lib/voice-input-focus'
import type { VoiceDictationSettings } from '../../types'

/** 可能需要被长按管理器消费的指针事件类型。 */
type PressPointerEvent = React.PointerEvent<HTMLElement>

interface UseVoicePressToTalkResult {
  /** 「按住说话」是否可用；不可用时按钮保持原有点击 toggle 行为 */
  available: boolean
  /** 绑定到麦克风按钮的 pointerdown */
  down: (event: PressPointerEvent) => void
  /** 绑定到麦克风按钮的 pointermove */
  move: (event: PressPointerEvent) => void
  /** 绑定到麦克风按钮的 pointerup */
  up: (event: PressPointerEvent) => void
  /** 绑定到麦克风按钮的 pointercancel / pointerleave */
  cancel: (event?: PressPointerEvent) => void
  /** 长按已消费本次手势时应跳过 click，避免长按结束后又切换一次听写 */
  shouldSuppressClick: () => boolean
}

/**
 * @param sourceInputId 发起长按的输入框 ID，用于把识别文本回填到同一个输入框
 */
export function useVoicePressToTalk(sourceInputId?: string): UseVoicePressToTalkResult {
  const [available, setAvailable] = React.useState(false)
  /** 当前手势的消费与 click 抑制状态。 */
  const gestureStateRef = React.useRef(createPressToTalkGestureState())

  const controller = React.useMemo(
    () => new PressToTalkController({
      start: async (token) => {
        const selection = window.getSelection()
        // 有选中文本时用户多半想替换选区：不启动录音，同时消费掉本次手势，
        // 避免松开后的 click 又按普通模式启动听写。
        if (selection && !selection.isCollapsed) {
          consumePressGesture(gestureStateRef.current)
          return false
        }
        // 越过阈值并实际发起 start 就消费手势：即使 start 尚未 resolve 用户已松手，
        // pointerup 也能 arm 抑制，后续原生 click 一律跳过普通 toggle。
        // 被状态守卫拒绝（resolve(false)）也不回退 toggle，用户已确认该产品取舍。
        consumePressGesture(gestureStateRef.current)
        return await window.electronAPI.toggleVoiceDictation({
          sourceInputId,
          pressToTalk: { action: 'start', token },
        })
      },
      stop: async (token) => {
        await window.electronAPI.toggleVoiceDictation({
          sourceInputId,
          pressToTalk: { action: 'stop', token },
        })
      },
    }),
    [sourceInputId],
  )

  const markGestureEnded = React.useCallback((): void => {
    endPressGesture(gestureStateRef.current, Date.now())
  }, [])

  // 设置可用性：首次读取 + 设置页保存后的事件同步。
  React.useEffect(() => {
    let active = true
    let receivedEvent = false

    const applySettings = (settings: Pick<VoiceDictationSettings, 'enabled'> & {
      pressToTalkEnabled?: boolean
    }): void => {
      const next = settings.enabled === true && settings.pressToTalkEnabled === true
      setAvailable(next)
      if (!next) controller.finish()
    }

    const handleSettingsChanged = (event: Event): void => {
      receivedEvent = true
      const detail = (event as CustomEvent<Partial<VoiceDictationSettings>>).detail
      if (!detail) return
      applySettings({
        enabled: detail.enabled === true,
        pressToTalkEnabled: detail.pressToTalkEnabled === true,
      })
    }

    window.addEventListener(VOICE_DICTATION_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    window.electronAPI.getVoiceDictationSettings()
      .then((settings) => {
        // 事件先到（用户刚改过设置）时以事件为准，避免旧快照覆盖。
        if (!active || receivedEvent) return
        applySettings(settings)
      })
      .catch((error: unknown) => {
        console.error('[语音输入] 读取按住说话设置失败:', error)
      })

    return () => {
      active = false
      window.removeEventListener(VOICE_DICTATION_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
      controller.finish()
    }
  }, [controller])

  // 会话期间的全局兜底：指针移出按钮、窗口失焦、切走后端都要收尾。
  React.useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      controller.move(event.pointerId, event.clientX, event.clientY)
    }
    const handlePointerUp = (event: PointerEvent): void => {
      controller.finish(event.pointerId)
      markGestureEnded()
    }
    const handlePointerCancel = (): void => {
      controller.finish()
      markGestureEnded()
    }
    // 指针离开整个窗口（relatedTarget 为空）时才收尾；普通元素间移动不打断会话。
    const handlePointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget) return
      controller.finish()
      markGestureEnded()
    }
    const handleBlur = (): void => {
      controller.finish()
      markGestureEnded()
    }
    const handleVisibilityChange = (): void => {
      if (!document.hidden) return
      controller.finish()
      markGestureEnded()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.cancelPending()
    }

    window.addEventListener('pointermove', handlePointerMove, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerCancel, true)
    window.addEventListener('pointerout', handlePointerOut, true)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerCancel, true)
      window.removeEventListener('pointerout', handlePointerOut, true)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      controller.finish()
    }
  }, [controller, markGestureEnded])

  // 输入框切换时结束残留会话，避免文本回到旧输入框。
  React.useEffect(() => {
    controller.finish()
  }, [controller, sourceInputId])

  const down = React.useCallback((event: PressPointerEvent): void => {
    // 只响应左键（触摸的 button 也是 0），并跳过 Shift/Ctrl 等改键组合。
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    beginPressGesture(gestureStateRef.current)
    controller.down(event.pointerId, event.clientX, event.clientY)
  }, [controller])

  const move = React.useCallback((event: PressPointerEvent): void => {
    controller.move(event.pointerId, event.clientX, event.clientY)
  }, [controller])

  const up = React.useCallback((event: PressPointerEvent): void => {
    controller.finish(event.pointerId)
    markGestureEnded()
  }, [controller, markGestureEnded])

  const cancel = React.useCallback((): void => {
    controller.finish()
    markGestureEnded()
  }, [controller, markGestureEnded])

  const shouldSuppressClick = React.useCallback((): boolean => {
    return shouldSuppressPressToTalkClick(gestureStateRef.current, Date.now())
  }, [])

  return { available, down, move, up, cancel, shouldSuppressClick }
}
