/**
 * LiveCompactSettings - Live Compact 设置页
 *
 * 两块内容：
 * 1. 全局主闸：写 `settings.json` 的 `liveCompact.enabled`（既有 settings 更新通道）。
 *    关闭即硬停所有会话；开启后会话默认启用，会话级开关随 P4 提供。
 * 2. 上游算法同步：读取版本状态、检查上游 HEAD、同步（下载 → 三重闸 → 原子激活）与
 *    回退内置版本。下载、解包、测试闸全部在主进程完成，本页只展示结论。
 *
 * 状态管理刻意保持页面内瞬态（与 ComputerUseSettings 一致）：版本状态不进全局 atom，
 * 离开设置页后重新挂载再拉一次即可，避免过期状态在其它视图里被误读。
 */

import * as React from 'react'
import {
  AlertTriangle,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import type { LiveCompactState } from '@proma/shared'
import type { LiveCompactSettings as LiveCompactSettingsValue } from '@/types/settings'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

/** 主闸缺省关闭：未启用时运行链路零变化。 */
const DEFAULT_SETTINGS: LiveCompactSettingsValue = { enabled: false }

/** sha 短码：7 位足够在状态卡里区分版本（与激活目录命名一致）。 */
function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

/** ISO 时间转本地可读格式；无法解析时原样展示，避免状态卡整行消失。 */
function formatTimestamp(iso: string | undefined): string {
  if (!iso) return ''
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString()
}

/** 把异常转换为可读文案。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LiveCompactSettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<LiveCompactSettingsValue>(DEFAULT_SETTINGS)
  const [saving, setSaving] = React.useState(false)

  const [state, setState] = React.useState<LiveCompactState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [appSettings, liveCompactState] = await Promise.all([
          window.electronAPI.getSettings(),
          window.electronAPI.getLiveCompactState(),
        ])
        if (cancelled) return
        setSettings(appSettings.liveCompact ?? DEFAULT_SETTINGS)
        setState(liveCompactState)
      } catch (error) {
        console.error('[Live Compact 设置] 加载失败:', error)
        if (!cancelled) setLoadError(describeError(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 重新读版本状态：检查/同步/回退后都走这里，状态卡与主进程保持同一来源。 */
  const refreshState = React.useCallback(async (): Promise<LiveCompactState | null> => {
    try {
      const next = await window.electronAPI.getLiveCompactState()
      setState(next)
      setLoadError(null)
      return next
    } catch (error) {
      console.error('[Live Compact 设置] 刷新状态失败:', error)
      setLoadError(describeError(error))
      return null
    }
  }, [])

  /** 主闸落盘：乐观更新，失败回滚并提示。 */
  const updateEnabled = async (enabled: boolean): Promise<void> => {
    const previous = settings
    setSettings({ enabled })
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({ liveCompact: { enabled } })
    } catch (error) {
      console.error('[Live Compact 设置] 保存主闸失败:', error)
      setSettings(previous)
      toast.error('保存 Live Compact 开关失败', { description: describeError(error) })
    } finally {
      setSaving(false)
    }
  }

  /** 检查上游 HEAD：只查 sha 与日期，不下载、不激活。 */
  const handleCheck = async (): Promise<void> => {
    if (checking || syncing) return
    setChecking(true)
    try {
      const result = await window.electronAPI.checkLiveCompactUpstream()
      await refreshState()
      if (result.updateAvailable) {
        toast.info(`上游有新提交：${shortSha(result.sha)}`)
      } else {
        toast.success('当前算法已对应当前上游版本')
      }
    } catch (error) {
      console.error('[Live Compact 设置] 检查上游失败:', error)
      toast.error('检查上游失败', { description: describeError(error) })
    } finally {
      setChecking(false)
    }
  }

  /** 同步上游：主进程跑三重闸，失败原因直接展示在弹窗与状态卡。 */
  const handleSync = async (): Promise<void> => {
    if (syncing || checking) return
    setSyncing(true)
    try {
      const result = await window.electronAPI.syncLiveCompactUpstream()
      setState(result.state)
      if (result.ok) {
        toast.success('已同步上游算法，新会话启动后生效')
      } else {
        toast.error('同步上游失败', { description: result.error })
      }
    } catch (error) {
      console.error('[Live Compact 设置] 同步上游失败:', error)
      toast.error('同步上游失败', { description: describeError(error) })
    } finally {
      setSyncing(false)
    }
  }

  /** 回退内置版本：只删激活标记，已下载的版本目录保留。 */
  const handleReset = async (): Promise<void> => {
    if (resetting || syncing) return
    setResetting(true)
    try {
      const next = await window.electronAPI.resetLiveCompactToBundled()
      setState(next)
      toast.success('已回退到内置算法，新会话启动后生效')
    } catch (error) {
      console.error('[Live Compact 设置] 回退内置版本失败:', error)
      toast.error('回退内置版本失败', { description: describeError(error) })
    } finally {
      setResetting(false)
    }
  }

  const active = state?.active
  const upstream = state?.upstream
  const busy = syncing || state?.syncing === true

  return (
    <div className="w-full space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Live Compact</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            对话变长时，把已完成的段落就地压成可回溯的卡片，减少上下文占用。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => void refreshState()}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
          刷新状态
        </Button>
      </div>

      <SettingsSection
        title="全局开关"
        description="这是主开关，缺省关闭；未开启时不改变任何会话的运行方式。"
      >
        <SettingsCard>
          <SettingsRow
            label="启用 Live Compact"
            icon={<Sparkles className="size-4 text-violet-500" />}
            description="关闭会立即停止所有会话（包括单独关闭过的会话）；开启后新会话默认启用，会话级开关即将提供。"
          >
            <Switch
              checked={settings.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => void updateEnabled(enabled)}
            />
          </SettingsRow>
        </SettingsCard>
        <p className="text-xs leading-relaxed text-muted-foreground">
          缺省关闭：未开启时运行链路与现在完全一致；开启后按当前模型窗口比例自动触发压缩。
        </p>
      </SettingsSection>

      <SettingsSection title="工作原理" description="全程本地完成，不额外调用模型。">
        <SettingsCard>
          <SettingsRow
            label="就地压缩为卡片"
            icon={<Layers className="size-4 text-sky-500" />}
            description="已完成的工具输出与文件内容会被替换为带来源的提取式卡片，只保留结论与引用；未压缩的原文不在上下文里重复出现。"
          />
          <SettingsRow
            label="不消耗额外 token"
            icon={<ShieldCheck className="size-4 text-emerald-500" />}
            description="压缩不调用模型，只做本地提取，因此前缀缓存保持有效，长对话不会因压缩而整体重算。"
          />
          <SettingsRow
            label="原文可随时取回"
            icon={<Package className="size-4 text-amber-500" />}
            description="被切掉的原文保存在会话的 sidecar 文件里，需要时由 spine_recall 工具按卡片引用取回。"
          />
          <SettingsRow
            label="阈值按模型窗口换算"
            icon={<Sparkles className="size-4 text-muted-foreground" />}
            description="触发线、保留轮预算与紧急线按当前模型上下文窗口的比例自动换算，窗口大小变化时无需手动调整。"
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="算法版本"
        description="内置版本随 App 发版；也可以同步上游算法覆盖内置版本。"
      >
        <SettingsCard>
          <SettingsRow
            label="内置版本"
            icon={<Package className="size-4 text-muted-foreground" />}
            description="随 App 发布的算法，始终可用，回退时回到这一版。"
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {state ? `v${state.bundledVersion}` : '读取中…'}
              {state?.bundledSha ? ` · ${shortSha(state.bundledSha)}` : ''}
            </span>
          </SettingsRow>

          <SettingsRow
            label="当前生效"
            icon={<Layers className="size-4 text-muted-foreground" />}
            description={active
              ? `已同步覆盖层，同步于 ${formatTimestamp(active.syncedAt)}。`
              : '未同步，使用内置算法。'}
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {active ? `v${active.version} · ${shortSha(active.sha)}` : '内置'}
            </span>
          </SettingsRow>

          <SettingsRow
            label="上游最新"
            icon={<RefreshCw className="size-4 text-muted-foreground" />}
            description={upstream
              ? `上游提交时间 ${formatTimestamp(upstream.date)}，检查于 ${formatTimestamp(upstream.checkedAt)}。`
              : '未检查。点「检查上游」查询上游默认分支的最新提交。'}
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {upstream ? shortSha(upstream.sha) : '未检查'}
            </span>
          </SettingsRow>

          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || checking || busy}
              onClick={() => void handleCheck()}
            >
              {checking
                ? <><Loader2 className="animate-spin" />正在检查…</>
                : <><RefreshCw />检查上游</>}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={loading || syncing || checking}
              onClick={() => void handleSync()}
            >
              {syncing
                ? <><Loader2 className="animate-spin" />正在同步…</>
                : <><RefreshCw />同步上游</>}
            </Button>
            {active && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading || resetting || busy}
                onClick={() => void handleReset()}
              >
                {resetting
                  ? <><Loader2 className="animate-spin" />正在回退…</>
                  : <><RotateCcw />回退内置版本</>}
              </Button>
            )}
            {syncing && (
              <span className="text-xs text-muted-foreground">
                正在下载并跑版本、导出形状与上游算法测试三重校验，通常需要十几秒。
              </span>
            )}
          </div>
        </SettingsCard>

        {state?.lastError && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>上次同步未激活：{state.lastError}</span>
          </div>
        )}
        {loadError && (
          <p className="text-xs text-muted-foreground">读取版本状态失败：{loadError}</p>
        )}
      </SettingsSection>

      <SettingsSection title="风险提示">
        <SettingsCard divided={false}>
          <ul className="space-y-2 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>上下文会在对话进行中被就地改写，因此全局主闸缺省关闭；关闭后所有会话立即停止改写。</span>
            </li>
            <li className="flex gap-2">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
              <span>同步上游要过三重校验：版本号合法、导出形状齐全、上游 94 例算法测试实跑通过；任一失败都不会激活，继续使用当前版本。</span>
            </li>
            <li className="flex gap-2">
              <Layers aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span>运行中的会话保持旧算法直到重启，已同步的算法只对之后启动的会话生效。</span>
            </li>
            <li className="flex gap-2">
              <RotateCcw aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span>「回退内置版本」只删除激活标记，不删除已下载的版本目录，随时可以重新同步。</span>
            </li>
          </ul>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
