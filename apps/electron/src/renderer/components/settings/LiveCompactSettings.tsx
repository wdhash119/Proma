/**
 * LiveCompactSettings - Live Compact 设置页
 *
 * 五块内容（顺序即页面顺序）：
 * 1. 全局主闸：写 `settings.json` 的 `liveCompact.enabled`（既有 settings 更新通道）。
 *    关闭即硬停所有会话；开启后会话默认启用，可在会话工具栏单独关闭。
 * 2. 当前轮保护：`liveCompact.protectCurrentTurn`，缺省开；关闭回到上游行为。
 * 3. Advanced：四条线（起切 / 保留 / 紧急 / 停手）可在比例与绝对值之间切换，
 *    带显式保存按钮与比例模式试算（试算纯前端，不落盘）。
 * 4. Origin：上游 dsh-live-compact 的原值，只读展示，不提供编辑入口。
 * 5. 上游算法同步：读取版本状态、检查上游 HEAD、同步（下载 → 三重闸 → 原子激活）与
 *    回退内置版本。下载、解包、测试闸全部在主进程完成，本页只展示结论。
 *
 * 状态管理刻意保持页面内瞬态（与 ComputerUseSettings 一致）：版本状态与四条线草稿都不进
 * 全局 atom，离开设置页后重新挂载再拉一次即可，避免过期状态在其它视图里被误读。
 * 唯一的例外是主闸：会话工具栏按钮读 `liveCompactGlobalEnabledAtom`，保存成功后必须同步。
 */

import * as React from 'react'
import {
  AlertTriangle,
  Check,
  Gauge,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import type { LiveCompactState } from '@proma/shared'
import type {
  LiveCompactLineMode,
  LiveCompactSettings as LiveCompactSettingsValue,
} from '@/types/settings'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
} from './primitives'
import {
  absoluteToDraft,
  calculateLinePreview,
  formatRatioPercent,
  formatTokenCount,
  LIVE_COMPACT_LINE_KEYS,
  LIVE_COMPACT_LINE_LABELS,
  LIVE_COMPACT_ORIGIN_KNOB_ROWS,
  LIVE_COMPACT_ORIGIN_LINE_ROWS,
  parsePreviewWindow,
  PREVIEW_WINDOW_COMPARISON,
  PREVIEW_WINDOW_DEFAULT,
  RENDERER_DEFAULT_LINE_ABSOLUTE,
  RENDERER_DEFAULT_LINE_RATIOS,
  ratiosToDraft,
  validateLineDraft,
  type LiveCompactLineDraft,
  type LiveCompactLineKey,
  type LiveCompactOriginRow,
} from './live-compact-line-model'
import { liveCompactGlobalEnabledAtom } from '@/atoms/agent-atoms'

/** 主闸缺省关闭：未启用时运行链路零变化。 */
const DEFAULT_SETTINGS: LiveCompactSettingsValue = { enabled: false }

/** 四条线取值模式的分段选项。 */
const LINE_MODE_OPTIONS = [
  { value: 'ratio', label: '比例（按模型窗口）' },
  { value: 'absolute', label: '绝对值（token）' },
]

/** 四条线的语义说明：比例模式谈占比，绝对值模式强调“不随窗口变化”。 */
const LINE_HELP: Readonly<Record<LiveCompactLineKey, { ratio: string; absolute: string }>> = {
  trigger: {
    ratio: '上下文占用低于这条线时整个 turn 直接返回，不选段也不切。缺省 0.5（50% 窗口）。',
    absolute: '上下文占用低于这条线时整个 turn 直接返回。填绝对 token 数，不随窗口变化。',
  },
  keepRound: {
    ratio: '最新几个已结束工具轮的保留预算，同时是收尾（drain）压到的停止水位。不能高于起切线；缺省 0.35。',
    absolute: '收尾停止水位与保留预算（token）。绝对值模式不要求它低于起切线：上游 Origin 就是 32000 > 20000。',
  },
  urgent: {
    ratio: '云端占用达到这条线即强制收尾。缺省 0.75，刻意低于 Pi 官方自动压缩的 80% 窗口（spine 先行、官方兜底）。',
    absolute: '云端占用达到这条线即强制收尾（绝对 token 数）。',
  },
  bigGate: {
    ratio: '总量到这条线即完全让位给官方自动压缩，不再切。缺省 0.9，高于紧急线与官方 80% 线。',
    absolute: '总量到这条线即完全让位给官方自动压缩（绝对 token 数）。',
  },
}

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

/** Origin 行的第二行说明：这个值能不能改、以及它的作用。 */
function describeOriginRow(row: LiveCompactOriginRow): string {
  const configurability = row.configurability === 'env' && row.envKey
    ? `可用环境变量 ${row.envKey} 覆盖`
    : '上游硬编码，不可配'
  return `${row.note}；${configurability}。`
}

/** Origin 行右侧的只读取值。 */
function OriginValue({ row }: { row: LiveCompactOriginRow }): React.ReactElement {
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {formatTokenCount(row.value)} {row.unit}
    </span>
  )
}

/** 试算结果的一行（标签 + token 数）。 */
function PreviewLine({
  label,
  tokens,
  muted,
}: {
  label: string
  tokens: number
  muted?: boolean
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', muted ? 'text-muted-foreground' : 'text-foreground')}>
        {formatTokenCount(tokens)}
      </span>
    </div>
  )
}

export function LiveCompactSettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<LiveCompactSettingsValue>(DEFAULT_SETTINGS)
  const [saving, setSaving] = React.useState(false)
  const [protectSaving, setProtectSaving] = React.useState(false)
  /** 四条线用显式保存按钮：数值型设置不做即时保存，避免半截输入被写盘。 */
  const [lineSaving, setLineSaving] = React.useState(false)
  const [lineMode, setLineMode] = React.useState<LiveCompactLineMode>('ratio')
  const [ratioDraft, setRatioDraft] = React.useState<LiveCompactLineDraft>(
    () => ratiosToDraft(RENDERER_DEFAULT_LINE_RATIOS),
  )
  const [absoluteDraft, setAbsoluteDraft] = React.useState<LiveCompactLineDraft>(
    () => absoluteToDraft(RENDERER_DEFAULT_LINE_ABSOLUTE),
  )
  const [previewWindowDraft, setPreviewWindowDraft] = React.useState(
    () => String(PREVIEW_WINDOW_DEFAULT),
  )
  // 会话工具栏按钮读的是这个 atom；设置页保存成功后同步写入，
  // 否则已经挂载的 AgentView 会一直拿启动时的旧值。
  const setGlobalEnabledAtom = useSetAtom(liveCompactGlobalEnabledAtom)

  const [state, setState] = React.useState<LiveCompactState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)

  /**
   * 用主进程返回的设置整页刷新（首次加载与保存四条线成功后共用）。
   *
   * 只在这里重置四条线草稿：主闸/保护开关的保存走 `patchSettings`，
   * 不能让它们把用户还没保存的四条线输入顺手清掉。
   */
  const applySettings = React.useCallback((next: LiveCompactSettingsValue): void => {
    setSettings(next)
    setGlobalEnabledAtom(next.enabled === true)
    setLineMode(next.lineMode === 'absolute' ? 'absolute' : 'ratio')
    setRatioDraft(ratiosToDraft(next.ratios ?? RENDERER_DEFAULT_LINE_RATIOS))
    setAbsoluteDraft(absoluteToDraft(next.absolute ?? RENDERER_DEFAULT_LINE_ABSOLUTE))
  }, [setGlobalEnabledAtom])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [appSettings, liveCompactState] = await Promise.all([
          window.electronAPI.getSettings(),
          window.electronAPI.getLiveCompactState(),
        ])
        if (cancelled) return
        applySettings(appSettings.liveCompact ?? DEFAULT_SETTINGS)
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
  }, [applySettings])

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

  /** 只改已落盘字段，不动四条线草稿。 */
  const patchSettings = (patch: Partial<LiveCompactSettingsValue>): void => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }

  /** 主闸落盘：乐观更新，失败回滚并提示。 */
  const updateEnabled = async (enabled: boolean): Promise<void> => {
    const previous = settings
    patchSettings({ enabled })
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({ liveCompact: { enabled } })
      // 落盘成功后再同步 atom：失败路径要保留工具栏原状态。
      setGlobalEnabledAtom(enabled)
    } catch (error) {
      console.error('[Live Compact 设置] 保存主闸失败:', error)
      setSettings(previous)
      toast.error('保存 Live Compact 开关失败', { description: describeError(error) })
    } finally {
      setSaving(false)
    }
  }

  /** 当前轮保护开关：同样乐观更新 + 失败回滚；保存后下一条消息生效。 */
  const updateProtectCurrentTurn = async (protectCurrentTurn: boolean): Promise<void> => {
    const previous = settings
    patchSettings({ protectCurrentTurn })
    setProtectSaving(true)
    try {
      // 只发这一个字段：主进程把补丁合到磁盘现值上，页面加载时的旧主闸值不会回写。
      const result = await window.electronAPI.updateSettings({
        liveCompact: { protectCurrentTurn },
      })
      // 主进程归一化后的值才是真值（例如未来收紧语义时），以返回值为准。
      patchSettings({ protectCurrentTurn: result.liveCompact?.protectCurrentTurn ?? protectCurrentTurn })
      toast.success(
        protectCurrentTurn ? '已开启当前轮保护' : '已关闭当前轮保护',
        { description: '下一条消息生效，当前进行中的那一轮不受影响。' },
      )
    } catch (error) {
      console.error('[Live Compact 设置] 保存当前轮保护失败:', error)
      setSettings(previous)
      toast.error('保存当前轮保护开关失败', { description: describeError(error) })
    } finally {
      setProtectSaving(false)
    }
  }

  const currentDraft = lineMode === 'ratio' ? ratioDraft : absoluteDraft
  const setDraft = (key: LiveCompactLineKey, value: string): void => {
    if (lineMode === 'ratio') {
      setRatioDraft((prev) => ({ ...prev, [key]: value }))
      return
    }
    setAbsoluteDraft((prev) => ({ ...prev, [key]: value }))
  }

  // 校验与试算都在渲染期算：输入框是受控的，重算成本只有四条减法。
  const validation = React.useMemo(() => validateLineDraft(lineMode, currentDraft), [lineMode, currentDraft])
  const validatedRatios = validation.ok && validation.mode === 'ratio' ? validation.ratios : null
  const previewWindow = React.useMemo(() => parsePreviewWindow(previewWindowDraft), [previewWindowDraft])
  const preview = React.useMemo(() => {
    if (validatedRatios === null || previewWindow.value === null) return null
    return calculateLinePreview(previewWindow.value, validatedRatios)
  }, [validatedRatios, previewWindow.value])
  const comparisonPreview = React.useMemo(() => {
    if (validatedRatios === null) return null
    return calculateLinePreview(PREVIEW_WINDOW_COMPARISON, validatedRatios)
  }, [validatedRatios])

  /** 保存四条线：输入框字符串先转 number，`Number.isFinite` 不通过就不发请求。 */
  const saveLines = async (): Promise<void> => {
    if (lineSaving || !validation.ok) return
    // 校验通过时判别联合只剩当前模式那一组值，这里按模式取用即可（不需要非空断言）。
    const payload = validation.mode === 'ratio'
      ? { lineMode: 'ratio' as const, ratios: validation.ratios }
      : { lineMode: 'absolute' as const, absolute: validation.absolute }
    setLineSaving(true)
    try {
      // 只发四条线：`enabled` 等无关字段省略后由主进程保留磁盘现值，
      // 因此这里不会用页面加载时的旧主闸值覆盖其它窗口刚改过的开关。
      const result = await window.electronAPI.updateSettings({
        liveCompact: payload,
      })
      // 以主进程归一化后的结果回刷页面：界面上剩下的就是真正生效的值。
      applySettings(result.liveCompact ?? settings)
      toast.success('已保存四条线', { description: '下一条消息生效，当前进行中的那一轮不受影响。' })
    } catch (error) {
      console.error('[Live Compact 设置] 保存四条线失败:', error)
      toast.error('保存四条线失败', { description: describeError(error) })
    } finally {
      setLineSaving(false)
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
        toast.success('当前算法已是上游最新版本')
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
  /** 缺省保护：只有显式 false 才算关闭（与主进程归一化一致）。 */
  const protectCurrentTurn = settings.protectCurrentTurn !== false

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
            description="关闭会立即停止所有会话的上下文改写（包括曾单独开启的会话）；开启后会话默认启用，可在会话工具栏单独关闭。"
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

      <SettingsSection
        title="当前轮保护"
        description="与上下文改写范围有关的安全开关，缺省开启；保存后下一条消息生效。"
      >
        <SettingsCard>
          <SettingsRow
            label="保护刚结束的这一轮"
            icon={<ShieldCheck className="size-4 text-emerald-500" />}
            description="开启时，刚结束的这一轮（末条消息与其工具结果）和投影尾部永不被压缩，长输出的收尾阶段不会被切开。关闭则回到上游算法行为：这一轮也可能被切成卡片，历史上曾在长输出收尾处导致任务被静默截断。"
          >
            <Switch
              checked={protectCurrentTurn}
              disabled={protectSaving || loading}
              onCheckedChange={(checked) => void updateProtectCurrentTurn(checked)}
            />
          </SettingsRow>
        </SettingsCard>
        <p className="text-xs leading-relaxed text-muted-foreground">
          缺省开启。关闭后上游算法不再跳过当前轮，压缩可能发生在模型正在读的最后一段输出上；
          只在需要复现上游行为或排查压缩效果时关闭。
        </p>
      </SettingsSection>

      <SettingsSection
        title="Advanced：四条线"
        description="把触发、保留、紧急、停手四条线改成比例或绝对 token。保存后下一条消息生效（同一会话即可，当前进行中的那一轮不受影响）。"
      >
        <SettingsCard>
          <SettingsSegmentedControl
            label="取值模式"
            description="比例：按当前模型上下文窗口换算，换模型不必重配；绝对值：直接给 token 数，不随窗口变化。"
            value={lineMode}
            onValueChange={(value) => setLineMode(value === 'absolute' ? 'absolute' : 'ratio')}
            options={LINE_MODE_OPTIONS}
            disabled={loading}
          />
          {LIVE_COMPACT_LINE_KEYS.map((key) => (
            <SettingsInput
              key={key}
              label={`${LIVE_COMPACT_LINE_LABELS[key]}（${lineMode === 'ratio' ? '窗口占比' : 'token'}）`}
              description={LINE_HELP[key][lineMode]}
              value={currentDraft[key]}
              onChange={(value) => setDraft(key, value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveLines()
              }}
              placeholder={lineMode === 'ratio' ? '0.5' : '20000'}
              disabled={loading}
              error={validation.errors[key]}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <Button
              type="button"
              size="sm"
              disabled={loading || lineSaving || !validation.ok}
              onClick={() => void saveLines()}
            >
              {lineSaving
                ? <><Loader2 className="animate-spin" />正在保存…</>
                : <><Check />保存四条线</>}
            </Button>
            <span className="text-xs text-muted-foreground">
              {validation.ok
                ? '保存后下一条消息生效；比例换算与主进程一致：Math.max(1, Math.round(窗口 × 占比))。'
                : '顺序不合法，先修正标红的输入框再保存。'}
            </span>
          </div>
        </SettingsCard>

        {lineMode === 'ratio' && (
          <SettingsCard>
            <SettingsInput
              label="试算上下文长度（token）"
              description="纯前端预览：不参与保存，也不影响实际生效值。缺省 200000，可改成手头模型的实际窗口。"
              value={previewWindowDraft}
              onChange={setPreviewWindowDraft}
              placeholder={String(PREVIEW_WINDOW_DEFAULT)}
              error={previewWindow.error ?? undefined}
              disabled={loading}
            />
            <div className="space-y-2 px-4 py-3">
              {preview ? (
                <>
                  <div className="text-xs text-muted-foreground">
                    窗口 {formatTokenCount(preview.windowTokens)} token 下的实际取值：
                  </div>
                  {preview.rows.map((row) => (
                    <PreviewLine
                      key={row.key}
                      label={`${row.label}（${formatRatioPercent(row.ratio)} 窗口）`}
                      tokens={row.tokens}
                    />
                  ))}
                  <PreviewLine
                    label="Pi 官方自动压缩线（80% 窗口，spine 之后由官方兜底）"
                    tokens={preview.piAutoCompactionTokens}
                    muted
                  />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  先修正上方比例并填一个有效的窗口大小，这里才会显示试算结果。
                </p>
              )}
            </div>
            {comparisonPreview && (
              <div className="space-y-2 px-4 py-3">
                <div className="text-xs text-muted-foreground">
                  对照 {formatTokenCount(comparisonPreview.windowTokens)} token 窗口：
                </div>
                {comparisonPreview.rows.map((row) => (
                  <PreviewLine
                    key={row.key}
                    label={`${row.label}（${formatRatioPercent(row.ratio)} 窗口）`}
                    tokens={row.tokens}
                  />
                ))}
                <PreviewLine
                  label="Pi 官方自动压缩线（80% 窗口）"
                  tokens={comparisonPreview.piAutoCompactionTokens}
                  muted
                />
              </div>
            )}
          </SettingsCard>
        )}
      </SettingsSection>

      <SettingsSection
        title="Origin（上游原逻辑，只读）"
        description="dsh-live-compact 的默认值是绝对 token 数、不随模型窗口变化。这里只展示，不提供编辑入口。"
      >
        <SettingsCard>
          <div className="space-y-1 px-4 pb-1 pt-3">
            <div className="text-sm font-medium text-foreground">四条线</div>
            <div className="text-xs text-muted-foreground">上游 settings.js 默认值 + index.js 硬编码</div>
          </div>
          {LIVE_COMPACT_ORIGIN_LINE_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              label={row.label}
              description={describeOriginRow(row)}
            >
              <OriginValue row={row} />
            </SettingsRow>
          ))}
        </SettingsCard>

        <SettingsCard>
          <div className="space-y-1 px-4 pb-1 pt-3">
            <div className="text-sm font-medium text-foreground">选段旋钮</div>
            <div className="text-xs text-muted-foreground">
              上游在模块加载时读取并求值成常量，运行期再改无效；本次只读展示。
            </div>
          </div>
          {LIVE_COMPACT_ORIGIN_KNOB_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              label={row.label}
              description={describeOriginRow(row)}
            >
              <OriginValue row={row} />
            </SettingsRow>
          ))}
        </SettingsCard>

        <SettingsCard divided={false}>
          <ul className="space-y-2 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <Gauge aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-sky-500" />
              <span>
                上游四条线是<strong className="font-medium text-foreground">绝对 token 数、不随窗口变化</strong>：
                同样的 32000 保留线，在 200K 窗口是 16%，在 1M 窗口只剩约 3%。
              </span>
            </li>
            <li className="flex gap-2">
              <Layers aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
              <span>
                上游保留线 32000 高于起切线 20000，这不是笔误：等价于云端每轮收尾最多只切一刀。
                绝对值模式因此不把“保留线高于起切线”当非法。
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span>
                绝对值模式下保留线是收尾停止水位：1M 窗口直接填上游 Origin，上下文会被一路压到 32000 token。
                只在要复现上游行为时这样填，否则请用比例模式。
              </span>
            </li>
          </ul>
        </SettingsCard>
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
            description="比例模式下触发线、保留轮预算与紧急线按当前模型上下文窗口的比例自动换算，窗口大小变化时无需手动调整；绝对值模式则固定不随窗口变化。"
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
              <span>当前轮保护缺省开启：刚结束的这一轮与投影尾部不会被切；关闭后才回到上游“当前轮也可能被切”的行为。</span>
            </li>
            <li className="flex gap-2">
              <Gauge aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-sky-500" />
              <span>四条线的改动保存后下一条消息生效（同一会话即可），当前进行中的那一轮按旧阈值走完；阈值求值失败时本轮直接不启用，不会下发错误配置。</span>
            </li>
            <li className="flex gap-2">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
              <span>同步上游要过三重校验：版本号合法、导出形状齐全、上游 94 例算法测试实跑通过；任一失败都不会激活，继续使用当前版本。</span>
            </li>
            <li className="flex gap-2">
              <Layers aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span>同步上游算法只对之后启动的会话生效；运行中的会话保持旧算法直到重启。</span>
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
