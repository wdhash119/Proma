import { PROVIDER_LABELS } from '@proma/shared'
import type { Channel, ChannelPlanQuotaResult, ChannelPlanQuotaWindow, ProviderType } from '@proma/shared'

export interface LoadedPlanQuota {
  channelKey: string
  result: ChannelPlanQuotaResult
}

export function currentPlanQuota(loaded: LoadedPlanQuota | null, channelKey: string | null): ChannelPlanQuotaResult | null {
  return channelKey !== null && loaded?.channelKey === channelKey ? loaded.result : null
}

interface PlanQuotaDisplay {
  summary: string
  title: string
  muted: boolean
}

/** 显示状态必须与凭据版本绑定，不能在 effect 执行前闪现旧账号结果。 */
export function planQuotaChannelKey(channel: Pick<Channel, 'id' | 'updatedAt' | 'provider' | 'baseUrl'>): string {
  return JSON.stringify([channel.id, channel.updatedAt, channel.provider, channel.baseUrl])
}

/** 将重置时间转换为工具栏可承载的紧凑时长；不拿本地时间冒充供应商重置时间。 */
export function formatPlanQuotaResetDuration(resetAt: number | undefined, now = Date.now()): string | undefined {
  if (resetAt === undefined) return undefined
  const remainingMs = resetAt - now
  if (remainingMs <= 0) return '已到期'
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.ceil(hours / 24)}天`
}

/** 金额、积分等自身就是完整值的展示标签，不再重复“账户余额”等窗口名。 */
function hasStandaloneRemainingValue(window: ChannelPlanQuotaWindow): boolean {
  if (window.type !== 'custom' || !window.remainingLabel) return false
  return /^[\p{Sc}\d]/u.test(window.remainingLabel.trim())
}

function formatWindow(window: ChannelPlanQuotaWindow, now: number): string {
  const value = window.remainingLabel ?? `${window.remainingPercent}%`
  const reset = formatPlanQuotaResetDuration(window.resetAt, now)
  if (hasStandaloneRemainingValue(window)) {
    return `${value}${reset ? ` · ${reset}` : ''}`
  }
  const label = window.type === '5h' ? '5H' : window.type === 'weekly' ? '周' : window.label.replace(/\s+/g, '')
  return `${label} ${value}${reset ? ` · ${reset}` : ''}`
}

function formatPlanQuotaWindowValue(window: ChannelPlanQuotaWindow, provider: ProviderType): string {
  const date = window.resetAt === undefined ? undefined : new Date(window.resetAt)
  const reset = date && Number.isFinite(date.getTime())
    ? `，重置 ${new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(date)}`
    : provider === 'github-copilot' ? '，未提供重置时间' : ''
  const value = window.remainingLabel ?? `${window.remainingPercent}%`
  return `${window.showProgress === false ? value : `剩余 ${value}`}${reset}`
}

export function getPlanQuotaDisplay(
  quota: ChannelPlanQuotaResult | null,
  provider: ProviderType,
  now = Date.now(),
): PlanQuotaDisplay | null {
  const providerLabel = PROVIDER_LABELS[provider]
  if (!quota) {
    return { summary: '额度加载中', title: `正在读取${providerLabel}余额 / 订阅额度`, muted: true }
  }
  if (!quota.supported || quota.windows.length === 0) {
    return {
      summary: '额度不可用',
      title: quota.message ?? `${providerLabel}未提供可用的余额或订阅额度数据`,
      muted: true,
    }
  }

  const primary = [quota.windows.find((window) => window.type === '5h'), quota.windows.find((window) => window.type === 'weekly')]
    .filter((window): window is ChannelPlanQuotaWindow => Boolean(window))
  const summary = (primary.length > 0 ? primary : quota.windows.slice(0, 2))
    .map((window) => formatWindow(window, now))
    .join(' · ')
  const details = quota.windows.map((window) => `${window.label}: ${formatPlanQuotaWindowValue(window, provider)}`).join('\n')
  const title = `${quota.planName ?? '订阅额度'}\n${details}`
  // 部分成功（一个版本失败、另一个成功）只把脱敏提示追加到 tooltip 末尾，不改 summary。
  return { summary, title: quota.message ? `${title}\n${quota.message}` : title, muted: false }
}
