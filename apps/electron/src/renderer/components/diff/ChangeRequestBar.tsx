/**
 * ChangeRequestBar — 改动区的变更请求（PR）状态条
 *
 * 显示会话关联的 PR：默认收起为一行状态徽标，点开后可查看标题、检查结果，
 * 也能手动关联链接、刷新、隐藏或取消关联。轮询调整由主进程负责，这里只展示。
 */

import * as React from 'react'
import { ChevronDown, CircleDashed, GitPullRequest, Link2, Loader2, RotateCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ChangeRequestBinding, ChangeRequestSnapshot } from '@proma/shared'
import { isCheckFailed, isCheckPending, isCheckSuccessful } from '@proma/shared'

type Tone = 'busy' | 'ok' | 'warn' | 'bad' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  busy: 'text-primary',
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
}

const TONE_DOT: Record<Tone, string> = {
  busy: 'bg-primary animate-pulse',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
}

/** 把 PR 状态压成一句人能快速扫读的短语 + 颜色。 */
function describeChangeRequest(snapshot: ChangeRequestSnapshot | undefined): { label: string; tone: Tone } {
  if (!snapshot) return { label: '等待状态', tone: 'muted' }
  if (snapshot.state === 'MERGED') return { label: '已合并', tone: 'ok' }
  if (snapshot.state === 'CLOSED') return { label: '已关闭', tone: 'muted' }
  if (snapshot.checks.some(isCheckFailed)) {
    return { label: '检查失败', tone: 'bad' }
  }
  if (snapshot.checks.some(isCheckPending)) return { label: '检查中', tone: 'busy' }
  if (snapshot.reviewDecision === 'CHANGES_REQUESTED') return { label: '待修改', tone: 'warn' }
  if (snapshot.mergeable === 'CONFLICTING') return { label: '有冲突', tone: 'bad' }
  if (snapshot.isDraft) return { label: '草稿', tone: 'muted' }
  if (snapshot.reviewDecision === 'APPROVED') return { label: '已批准', tone: 'ok' }
  return { label: '待合并', tone: 'busy' }
}

interface ChangeRequestBarProps {
  sessionId: string
}

export function ChangeRequestBar({ sessionId }: ChangeRequestBarProps): React.ReactElement | null {
  const [bindings, setBindings] = React.useState<ChangeRequestBinding[]>([])
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<'discover' | 'refresh' | 'track' | null>(null)
  const [linkInput, setLinkInput] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const visibleBindings = React.useMemo(() => bindings.filter((binding) => !binding.dismissed), [bindings])

  const runAction = React.useCallback(async (
    action: 'list' | 'discover' | 'refresh' | 'track' | 'dismiss' | 'restore' | 'remove',
    options: { url?: string; busyKey?: 'discover' | 'refresh' | 'track' } = {},
  ) => {
    if (options.busyKey) setBusy(options.busyKey)
    setError(null)
    try {
      const result = await window.electronAPI.changeRequestsAction({
        sessionId,
        action,
        ...(options.url ? { url: options.url } : {}),
      })
      setBindings(result.bindings)
      if (result.error) setError(result.error)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '变更请求操作失败')
      return undefined
    } finally {
      if (options.busyKey) setBusy(null)
    }
  }, [sessionId])

  React.useEffect(() => {
    void runAction('list')
  }, [runAction])

  // 主进程轮询到新状态后推送；只刷新本会话，避免无谓的全量请求。
  React.useEffect(() => {
    return window.electronAPI.onChangeRequestsChanged(({ sessionIds }) => {
      if (!sessionIds.includes(sessionId)) return
      void runAction('list')
    })
  }, [runAction, sessionId])

  const handleTrack = React.useCallback(async () => {
    const url = linkInput.trim()
    if (!url) return
    const result = await runAction('track', { url, busyKey: 'track' })
    if (result && !result.error) setLinkInput('')
  }, [linkInput, runAction])

  const primary = visibleBindings[0]
  const status = describeChangeRequest(primary?.snapshot)

  return (
    <div className="shrink-0 border-b border-border/60 bg-content-area px-2 py-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted/60',
              primary ? 'text-foreground' : 'text-muted-foreground',
            )}
            aria-label={primary ? '查看变更请求状态' : '关联变更请求'}
          >
            <GitPullRequest className={cn('size-3.5 shrink-0', primary ? 'text-primary' : 'text-muted-foreground/60')} />
            {primary ? (
              <>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/80">#{primary.number}</span>
                <span className={cn('flex min-w-0 items-center gap-1', TONE_CLASS[status.tone])}>
                  <span className="truncate text-[11px]">{primary.error ? '状态过期' : status.label}</span>
                  {!primary.error && <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[status.tone])} aria-hidden="true" />}
                </span>
                {visibleBindings.length > 1 && (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    +{visibleBindings.length - 1}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[11px]">关联变更请求</span>
            )}
            <ChevronDown className={cn('ml-auto size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-180')} />
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-[360px] p-0">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-2">
            <span className="text-[12px] font-medium text-foreground/80">
              变更请求{visibleBindings.length > 0 ? ` (${visibleBindings.length})` : ''}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => { void runAction('discover', { busyKey: 'discover' }) }}
                title="按当前分支发现"
                aria-label="按当前分支发现"
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <CircleDashed className={cn('size-3.5', busy === 'discover' && 'animate-spin')} />
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => { void runAction('refresh', { busyKey: 'refresh' }) }}
                title="刷新状态"
                aria-label="刷新状态"
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <RotateCw className={cn('size-3.5', busy === 'refresh' && 'animate-spin')} />
              </button>
            </span>
          </div>

          <div className="space-y-1.5 p-2">
            {visibleBindings.length > 0 ? (
              <ul className="space-y-1.5">
                {visibleBindings.map((binding) => {
                  const bindingStatus = describeChangeRequest(binding.snapshot)
                  return (
                    <li key={binding.url} className="rounded-md border border-border/50 px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/80">#{binding.number}</span>
                        <span className={cn('flex min-w-0 items-center gap-1', TONE_CLASS[bindingStatus.tone])}>
                          <span className="truncate text-[11px]">{binding.error ? '状态过期' : bindingStatus.label}</span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => { void runAction('remove', { url: binding.url }) }}
                            title="取消关联"
                            aria-label="取消关联"
                            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/50 hover:bg-accent hover:text-destructive"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-foreground/85">
                        {binding.snapshot?.title || binding.url}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                        <span className="truncate">{binding.snapshot?.headRefName || binding.owner}</span>
                        {binding.snapshot && binding.snapshot.checks.length > 0 && (
                          <span className="shrink-0 tabular-nums">
                            {binding.snapshot.checks.filter(isCheckSuccessful).length}
                            /{binding.snapshot.checks.length} 通过
                          </span>
                        )}
                      </div>
                      {binding.error && (
                        <p className="mt-0.5 truncate text-[10px] text-amber-600 dark:text-amber-400" title={binding.error}>
                          {binding.error}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="px-1 py-1 text-[11.5px] text-muted-foreground">
                这个会话还没有关联的变更请求。可以粘贴链接手动关联，或让 Agent 创建 PR 后自动出现。
              </p>
            )}

            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                void handleTrack()
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Link2 className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/50" />
                <input
                  value={linkInput}
                  onChange={(event) => setLinkInput(event.target.value)}
                  placeholder="粘贴 PR 链接"
                  aria-label="PR 链接"
                  className="h-7 w-full rounded-md border border-border/60 bg-background pl-6.5 pr-2 text-[11.5px] outline-none focus:border-primary/40"
                />
              </div>
              <button
                type="submit"
                disabled={!linkInput.trim() || busy !== null}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 text-[11.5px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
              >
                {busy === 'track' ? <Loader2 className="size-3 animate-spin" /> : null}
                关联
              </button>
            </form>

            {error && (
              <p className="px-1 text-[10.5px] text-destructive" title={error}>{error}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
