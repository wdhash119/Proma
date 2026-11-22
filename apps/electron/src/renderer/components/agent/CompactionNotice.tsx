import * as React from 'react'
import { cn } from '@/lib/utils'

/** 上下文压缩进度；由 AgentMessages 从 live 消息与流状态推导，只用于对话内单行提示。 */
export interface ContextCompactionProgress {
  status: 'running' | 'success' | 'noop' | 'failed'
  label: string
  detail?: string
  summary?: string
}

/** 终态提示保留时长：足够读一眼，又不会长期占位。 */
export const COMPACTION_NOTICE_RETENTION_MS = 6_000

/**
 * 单行纯文本文案：压缩提示只表达「发生了什么」，摘要等长内容留给会话本身，
 * 避免把弹层信息塞回一行文字。
 */
export function buildCompactionNoticeText(progress: ContextCompactionProgress): string {
  const detail = progress.detail?.trim()
  switch (progress.status) {
    case 'running':
      return detail ? `${progress.label}：${detail}` : `${progress.label}…`
    case 'failed':
      return detail ? `${progress.label}：${detail}` : progress.label
    case 'noop':
    case 'success':
    default:
      return detail ? `${progress.label}：${detail}` : progress.label
  }
}

interface CompactionNoticeProps {
  progress: ContextCompactionProgress
}

/**
 * 上下文压缩的对话内反馈：运行中常驻一行，终态保留数秒后自动消失。
 * 样式与正文一致（同字号、行高），失败用错误色区分。
 */
export function CompactionNotice({ progress }: CompactionNoticeProps): React.ReactElement | null {
  const text = buildCompactionNoticeText(progress)
  const isRunning = progress.status === 'running'
  const [dismissed, setDismissed] = React.useState(false)

  React.useEffect(() => {
    setDismissed(false)
    if (isRunning) return
    const timer = window.setTimeout(() => setDismissed(true), COMPACTION_NOTICE_RETENTION_MS)
    return () => window.clearTimeout(timer)
  }, [isRunning, text])

  if (dismissed) return null

  return (
    <div className="pl-[56px]">
      <p
        className={cn(
          'truncate text-[length:var(--md-preview-font-size,15px)] leading-[1.6]',
          progress.status === 'failed' ? 'text-destructive/90' : 'text-muted-foreground',
        )}
        title={text}
      >
        {text}
      </p>
    </div>
  )
}
