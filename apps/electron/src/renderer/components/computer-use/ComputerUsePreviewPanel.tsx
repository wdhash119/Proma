/**
 * Computer Use 窗口镜像面板。
 *
 * Agent 调用 ComputerUsePreview 后，主进程会登记预览目标并按需采集画面；
 * 这里只负责轮询状态、渲染镜像，以及提供「打开窗口 / 重试 / 关闭」三个动作。
 *
 * 轮询策略：只有 Agent 正在工作，或仍有终态需要收尾时才每 2 秒拉取一次，
 * 避免空闲会话持续拉起 Cua Driver。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { LoaderCircle, MonitorUp, RefreshCw, X } from 'lucide-react'
import type { ComputerUsePreviewState } from '@proma/shared'
import { agentSessionViewStreamStateAtomFamily, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 轮询间隔：与主进程 2 秒的终态保留窗口对齐。 */
const PREVIEW_POLL_INTERVAL_MS = 2_000

function describeStatus(preview: ComputerUsePreviewState): string {
  if (preview.status === 'finished') return '预览已结束'
  if (preview.status === 'error') return '画面采集失败'
  if (preview.target === 'desktop') return '桌面镜像'
  return '窗口镜像'
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ComputerUsePreviewPanel(): React.ReactElement | null {
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  // 会话为空时读取占位 atom，避免条件调用 Hook。
  const streamState = useAtomValue(agentSessionViewStreamStateAtomFamily(sessionId ?? '__none__'))
  const running = sessionId ? streamState.running : false

  const [preview, setPreview] = React.useState<ComputerUsePreviewState | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [pendingAction, setPendingAction] = React.useState<'activate' | 'retry' | null>(null)

  const shouldPoll = running || preview?.status === 'finished'

  // 会话切换时丢弃上一会话的画面，避免把旧窗口镜像挂在新会话下。
  React.useEffect(() => {
    setPreview(null)
    setActionError(null)
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId || !shouldPoll) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const next = await window.electronAPI.getComputerUsePreview(sessionId)
        if (cancelled) return
        setPreview(next)
        // null 表示主进程已关闭该会话的预览，停止轮询。
        if (!next) return
      } catch (error) {
        if (cancelled) return
        setActionError(readErrorMessage(error))
        return
      }
      if (!cancelled) timer = setTimeout(() => { void tick() }, PREVIEW_POLL_INTERVAL_MS)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, shouldPoll])

  if (!sessionId || !preview) return null

  const isFrameless = preview.status === 'running' && !preview.image
  const canActivate = preview.target === 'window' && preview.status !== 'finished'
  const canRetry = preview.status === 'error'

  const handleActivate = async (): Promise<void> => {
    setPendingAction('activate')
    setActionError(null)
    try {
      await window.electronAPI.activateComputerUsePreview(sessionId, preview.id)
    } catch (error) {
      setActionError(readErrorMessage(error))
    } finally {
      setPendingAction(null)
    }
  }

  const handleRetry = async (): Promise<void> => {
    setPendingAction('retry')
    setActionError(null)
    try {
      const next = await window.electronAPI.retryComputerUsePreview(sessionId, preview.id)
      if (next) setPreview(next)
    } catch (error) {
      setActionError(readErrorMessage(error))
    } finally {
      setPendingAction(null)
    }
  }

  const handleDismiss = (): void => {
    const previewId = preview.id
    setPreview(null)
    setActionError(null)
    void window.electronAPI.dismissComputerUsePreview(sessionId, previewId).catch((error: unknown) => {
      console.error('[Computer Use] 关闭预览失败:', error)
    })
  }

  return (
    <aside
      className={cn(
        'absolute right-4 top-12 z-[55] flex w-[420px] max-w-[calc(100%-2rem)] flex-col overflow-hidden',
        'rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur-sm',
      )}
      aria-label="Computer Use 操作预览"
    >
      <header className="flex items-start gap-2 border-b border-border/70 px-3 py-2">
        <MonitorUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground" title={preview.label}>
            {preview.label}
          </div>
          <div className="text-[11px] text-muted-foreground">{describeStatus(preview)}</div>
        </div>
        {canActivate && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={pendingAction !== null}
            onClick={() => void handleActivate()}
          >
            {pendingAction === 'activate' ? <LoaderCircle className="size-3 animate-spin" /> : <MonitorUp className="size-3" />}
            打开窗口
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="关闭预览"
          title="关闭预览"
          onClick={handleDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="flex min-h-[120px] items-center justify-center bg-muted/25">
        {preview.status === 'error' ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <p className="text-xs text-destructive">{preview.error ?? '画面采集失败。'}</p>
            {canRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={pendingAction !== null}
                onClick={() => void handleRetry()}
              >
                {pendingAction === 'retry' ? <LoaderCircle className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                重试
              </Button>
            )}
          </div>
        ) : preview.status === 'finished' ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">预览已结束，画面即将关闭。</p>
        ) : preview.image ? (
          <img
            src={preview.image}
            alt={`${preview.label} 的实时镜像`}
            className="max-h-[48vh] w-full object-contain"
            draggable={false}
          />
        ) : (
          <p className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            {isFrameless ? '正在获取画面…' : '等待下一帧画面…'}
          </p>
        )}
      </div>

      {actionError && (
        <p className="border-t border-border/70 px-3 py-1.5 text-[11px] text-destructive">{actionError}</p>
      )}
      <footer className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>只显示画面，不执行点击</span>
        <span>
          {!running && preview.status === 'running' && '已暂停刷新 · '}
          {preview.capturedAt ? new Date(preview.capturedAt).toLocaleTimeString() : ''}
        </span>
      </footer>
    </aside>
  )
}
