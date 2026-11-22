import * as React from 'react'
import type { Channel } from '@proma/shared'
import { cn } from '@/lib/utils'
import { supportsChannelPlanQuota, fetchChannelPlanQuota } from '@/lib/channel-plan-quota'
import { currentPlanQuota, getPlanQuotaDisplay, planQuotaChannelKey } from '@/lib/channel-plan-quota-display'
import type { LoadedPlanQuota } from '@/lib/channel-plan-quota-display'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const QUOTA_REFRESH_INTERVAL_MS = 60_000

interface ChannelPlanQuotaBadgeProps {
  channel: Channel
  /** model-list 用于渠道分组；toolbar 用于 Agent 输入框圆圈旁。 */
  variant?: 'model-list' | 'toolbar'
}

export function ChannelPlanQuotaBadge({
  channel,
  variant = 'model-list',
}: ChannelPlanQuotaBadgeProps): React.ReactElement | null {
  const [loaded, setLoaded] = React.useState<LoadedPlanQuota | null>(null)
  const channelKey = planQuotaChannelKey(channel)
  const supported = supportsChannelPlanQuota(channel)

  React.useEffect(() => {
    if (!supported) return

    let cancelled = false
    const load = (): void => {
      void fetchChannelPlanQuota(channel.id, channel.updatedAt)
        .then((result) => {
          if (!cancelled) setLoaded({ channelKey, result })
        })
    }

    load()
    // toolbar 会长期挂载；按统一缓存周期刷新，模型选择器打开时也能取得新值。
    const timer = window.setInterval(load, QUOTA_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [supported, channel.id, channel.provider, channel.baseUrl, channel.updatedAt, channelKey])

  if (!supported) return null
  const quota = currentPlanQuota(loaded, channelKey)
  const display = getPlanQuotaDisplay(quota, channel.provider)
  if (!display) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={display.title}
          className={cn(
            'inline-flex shrink-0 items-center overflow-hidden whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
            variant === 'toolbar'
              ? 'h-8 max-w-[280px] rounded-md border border-transparent px-2 text-[11px] leading-none hover:bg-muted/50'
              : 'ml-auto rounded border px-1.5 py-0.5 text-[10px] leading-none',
            display.muted
              ? 'bg-transparent text-muted-foreground/70'
              : variant === 'toolbar'
                ? 'text-foreground/70'
                : 'border-foreground/10 bg-background/70 text-foreground/70',
          )}
        >
          <span className="min-w-0 truncate">{display.summary}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-pre-line">{display.title}</TooltipContent>
    </Tooltip>
  )
}
