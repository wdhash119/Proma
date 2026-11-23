/**
 * LiveCompactSettings - Live Compact 设置页
 *
 * 三段式布局（顺序即页面顺序）：
 * 1. 开关行：一张卡里并排两个主开关——全局主闸 `liveCompact.enabled`
 *    （关闭即硬停所有会话；开启后会话默认启用，可在会话工具栏单独关）与
 *    结束轮保护 `liveCompact.protectCurrentTurn`（缺省开，关闭回到上游行为）。
 * 2. 阈值设置：卡顶用分段控件选「原算法（上游默认）/ 自定义」。
 *    左列是只读的上游 Origin 四线；右列可编辑四条线，比例与绝对值两组输入并排，
 *    非生效一侧灰显显示按「参考上下文长度」实时换算的预览。保存是显式按钮（Enter 同效）。
 * 3. 算法更新：内置 / 当前生效 / 上游最新三行 + 检查、同步（三重闸）、回退。
 *    下载、解包、测试闸全部在主进程完成，本页只展示结论。
 *
 * 说明文字一律收进问号 tooltip（`SettingsHelpTip`），页面本身只留标题与控件。
 * 状态管理刻意保持页面内瞬态（与 ComputerUseSettings 一致）：版本状态与四条线草稿都不进
 * 全局 atom，离开设置页后重新挂载再拉一次即可，避免过期状态在其它视图里被误读。
 * 唯一的例外是主闸：会话工具栏按钮读 `liveCompactGlobalEnabledAtom`，保存成功后必须同步。
 */

import * as React from 'react'
import {
  AlertTriangle,
  Check,
  Layers,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import type { LiveCompactState } from '@proma/shared'
import type {
  LiveCompactLineMode,
  LiveCompactSettings as LiveCompactSettingsValue,
} from '@/types/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  SettingsCard,
  SettingsHelpTip,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
} from './primitives'
import {
  absoluteToDraft,
  calculateConversionPreview,
  formatTokenCount,
  LIVE_COMPACT_LINE_KEYS,
  LIVE_COMPACT_LINE_LABELS,
  LIVE_COMPACT_ORIGIN_LINE_ROWS,
  parsePreviewWindow,
  PREVIEW_WINDOW_DEFAULT,
  RENDERER_DEFAULT_LINE_ABSOLUTE,
  RENDERER_DEFAULT_LINE_RATIOS,
  ratiosToDraft,
  validateLineDraft,
  type LiveCompactConversionPreview,
  type LiveCompactEffectiveGroup,
  type LiveCompactLineDraft,
  type LiveCompactLineKey,
  type LiveCompactOriginRow,
} from './live-compact-line-model'
import { liveCompactGlobalEnabledAtom } from '@/atoms/agent-atoms'

/** 主闸缺省关闭：未启用时运行链路零变化。 */
const DEFAULT_SETTINGS: LiveCompactSettingsValue = { enabled: false }

/** 取值来源：原算法（上游 Origin 只读）或自定义。 */
const SOURCE_OPTIONS = [
  { value: 'origin', label: '原算法（上游默认）' },
  { value: 'custom', label: '自定义' },
]

/** 自定义列的取值方式。 */
const CUSTOM_MODE_OPTIONS = [
  { value: 'ratio', label: '比例' },
  { value: 'absolute', label: '绝对值' },
]

/** 页头问号：工作原理浓缩成一句。 */
const HEADER_HELP =
  '对话变长时把已完成的段落就地压成可回溯的卡片：全程本地完成，不调用模型、不额外消耗 token，被切掉的原文可用 spine_recall 按卡片引用取回。'

/** 全局主闸问号。 */
const MASTER_HELP =
  '主开关，缺省关闭。关闭会立即停止所有会话的上下文改写（包括曾单独开启的会话）；开启后会话默认启用，可在会话工具栏单独关闭。'

/** 结束轮保护问号。 */
const PROTECT_HELP =
  '缺省开启。刚结束的这一轮（末条消息与工具结果）与投影尾部永不被切；关闭则回到上游行为：当前轮也可能被切成卡片，历史上曾在长输出收尾处静默截断任务。保存后下一条消息生效。'

/** 原算法列头问号：选段旋钮 + 求值时机。 */
const ORIGIN_COLUMN_HELP =
  '上游 dsh-live-compact 的原值：绝对 token 数，不随模型窗口变化。选段旋钮（单段最小 1000 / 单段最大 32000 / 指针化 32000 / 保留轮数 3 / 冷却窗 0ms）在上游模块加载期求值成常量，运行期再改无效，所以这一列只读。'

/** 自定义取值方式问号。 */
const CUSTOM_MODE_HELP =
  '比例：按当前模型上下文窗口换算，换模型不必重配；绝对值：直接填 token 数，不随窗口变化。'

/** 参考上下文长度问号：灰框预览的语义边界。 */
const PREVIEW_WINDOW_HELP =
  '只用于灰框的换算预览：灰框显示按这个长度换算出的另一列数值，不是保存值，也不影响实际生效阈值。缺省 200000（200K 窗口）。'

/** 检查上游问号。 */
const CHECK_HELP = '只查询上游默认分支的最新提交（sha 与日期），不下载、不激活。'

/** 同步上游问号：三重闸。 */
const SYNC_HELP =
  '下载上游算法并过三重闸：版本号合法、导出形状齐全、上游 94 例算法测试实跑通过；任一失败都不会激活，继续使用当前版本。只对之后启动的会话生效。'

/** 回退内置版本问号。 */
const RESET_HELP = '只删除激活标记，不删除已下载的版本目录，随时可以重新同步。只对之后启动的会话生效。'

/** 四条线的语义（比例谈窗口占比，绝对值谈固定 token）。 */
const LINE_HELP: Readonly<Record<LiveCompactLineKey, { ratio: string; absolute: string }>> = {
  trigger: {
    ratio: '上下文占用低于这条线时整个 turn 直接返回，不选段也不切。缺省 50%。',
    absolute: '上下文占用低于这条线时整个 turn 直接返回。填绝对 token 数，不随窗口变化。',
  },
  keepRound: {
    ratio: '最新几个已结束工具轮的保留预算，同时是收尾压到的停止水位。不能高于起切线；缺省 35%。',
    absolute: '收尾停止水位与保留预算（token）。上游 Origin 就是 32000 > 起切线 20000，所以绝对值模式不要求它更低。',
  },
  urgent: {
    ratio: '云端占用达到这条线即强制收尾。缺省 75%，刻意低于 Pi 官方自动压缩的 80% 窗口（spine 先行、官方兜底）。',
    absolute: '云端占用达到这条线即强制收尾（绝对 token 数）。',
  },
  bigGate: {
    ratio: '总量到这条线即完全让位给官方自动压缩，不再切。缺省 90%，高于紧急线与官方 80% 线。',
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

/** Origin 行的 tooltip：这个值的作用 + 能不能改。 */
function describeOriginRow(row: LiveCompactOriginRow): string {
  const configurability = row.configurability === 'env' && row.envKey
    ? `可用环境变量 ${row.envKey} 覆盖`
    : '上游硬编码，不可配'
  return `${row.note}；${configurability}。`
}

/** 只读值框：与输入框同高，避免两列行高错位。 */
function ReadonlyValue({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex h-8 w-32 shrink-0 items-center justify-end rounded-md border border-border/60 bg-muted/40 px-2 text-sm tabular-nums text-muted-foreground">
      {children}
    </span>
  )
}

/** 开关行的一格：标签 + 问号 + 右侧 Switch。 */
function ToggleCell({
  label,
  help,
  helpLabel,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  help: string
  helpLabel: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <SettingsHelpTip content={help} label={helpLabel} />
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function LiveCompactSettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<LiveCompactSettingsValue>(DEFAULT_SETTINGS)
  const [saving, setSaving] = React.useState(false)
  const [protectSaving, setProtectSaving] = React.useState(false)
  /** 四条线与取值来源用显式保存按钮：数值型设置不做即时保存，避免半截输入被写盘。 */
  const [lineSaving, setLineSaving] = React.useState(false)
  /** 取值来源：origin = 上游原算法（只读），custom = 用户自定义四条线。 */
  const [source, setSource] = React.useState<'origin' | 'custom'>('custom')
  /** 自定义列内的比例 / 绝对值。与 source 分开存：origin 时仍记住上次选的那一档。 */
  const [customMode, setCustomMode] = React.useState<'ratio' | 'absolute'>('ratio')
  /** 比例草稿是百分数串（'50' = 50% 窗口），存储域仍是 fraction。 */
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
    const mode: LiveCompactLineMode = next.lineMode ?? 'ratio'
    setSource(mode === 'origin' ? 'origin' : 'custom')
    // origin 不携带自定义档位：保留用户上次选的 ratio/absolute，切回自定义才有落点。
    if (mode === 'ratio' || mode === 'absolute') setCustomMode(mode)
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

  /** 结束轮保护开关：同样乐观更新 + 失败回滚；保存后下一条消息生效。 */
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
        protectCurrentTurn ? '已开启结束轮保护' : '已关闭结束轮保护',
        { description: '下一条消息生效，当前进行中的那一轮不受影响。' },
      )
    } catch (error) {
      console.error('[Live Compact 设置] 保存结束轮保护失败:', error)
      setSettings(previous)
      toast.error('保存结束轮保护开关失败', { description: describeError(error) })
    } finally {
      setProtectSaving(false)
    }
  }

  /**
   * 取值来源切换：原算法 / 自定义是模式开关（不是数值），立即落盘。
   *
   * 这里只发 `lineMode`，不重发 ratios/absolute：主进程把补丁合到磁盘现值上，
   * 另一窗口刚保存的四条线不会被本页的旧草稿覆盖。切回自定义时沿用上次选的档位。
   */
  const updateLineSource = async (value: string): Promise<void> => {
    const next: 'origin' | 'custom' = value === 'origin' ? 'origin' : 'custom'
    if (next === source || lineSaving) return
    const previous = source
    const nextMode: LiveCompactLineMode = next === 'origin' ? 'origin' : customMode
    setSource(next)
    setLineSaving(true)
    try {
      const result = await window.electronAPI.updateSettings({ liveCompact: { lineMode: nextMode } })
      const savedMode: LiveCompactLineMode = result.liveCompact?.lineMode ?? nextMode
      patchSettings({ lineMode: savedMode })
      setSource(savedMode === 'origin' ? 'origin' : 'custom')
      if (savedMode === 'ratio' || savedMode === 'absolute') setCustomMode(savedMode)
    } catch (error) {
      console.error('[Live Compact 设置] 保存取值来源失败:', error)
      setSource(previous)
      toast.error('保存取值来源失败', { description: describeError(error) })
    } finally {
      setLineSaving(false)
    }
  }

  const currentDraft = customMode === 'ratio' ? ratioDraft : absoluteDraft
  /** 草稿按各自模式写回：非生效列显示的是换算预览，不参与草稿。 */
  const setDraft = (mode: 'ratio' | 'absolute', key: LiveCompactLineKey, value: string): void => {
    if (mode === 'ratio') {
      setRatioDraft((prev) => ({ ...prev, [key]: value }))
      return
    }
    setAbsoluteDraft((prev) => ({ ...prev, [key]: value }))
  }

  // 校验与换算都在渲染期算：输入框是受控的，重算成本只有四条乘除。
  const validation = React.useMemo(
    () => validateLineDraft(customMode, currentDraft),
    [customMode, currentDraft],
  )
  const effectiveGroup = React.useMemo<LiveCompactEffectiveGroup | null>(() => {
    if (!validation.ok) return null
    return validation.mode === 'ratio'
      ? { mode: 'ratio', ratios: validation.ratios }
      : { mode: 'absolute', absolute: validation.absolute }
  }, [validation])
  const previewWindow = React.useMemo(() => parsePreviewWindow(previewWindowDraft), [previewWindowDraft])
  // 非生效列的灰框内容：按「参考上下文长度」把生效组实时换算过去。
  const conversion = React.useMemo<LiveCompactConversionPreview | null>(() => {
    if (effectiveGroup === null || previewWindow.value === null) return null
    return calculateConversionPreview(effectiveGroup, previewWindow.value)
  }, [effectiveGroup, previewWindow.value])

  /** 取某条线的换算预览文案；生效组非法或窗口非法时显示破折号。 */
  const conversionText = (key: LiveCompactLineKey): string => {
    if (conversion === null) return '—'
    return conversion.rows.find((row) => row.key === key)?.text ?? '—'
  }

  /** Enter 保存：与点「保存」等价，只作用于可编辑的那一列。 */
  const handleLineKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void saveLines()
  }

  /** 保存四条线：输入框字符串先转 number，`Number.isFinite` 不通过就不发请求。 */
  const saveLines = async (): Promise<void> => {
    if (lineSaving || !validation.ok || source === 'origin') return
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

  /** 恢复默认值：只把生效组的草稿重置为缺省，不落盘；点保存后才写设置。 */
  const resetLineDrafts = (): void => {
    if (customMode === 'ratio') {
      setRatioDraft(ratiosToDraft(RENDERER_DEFAULT_LINE_RATIOS))
      return
    }
    setAbsoluteDraft(absoluteToDraft(RENDERER_DEFAULT_LINE_ABSOLUTE))
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
  const isCustom = source === 'custom'
  const ratioActive = customMode === 'ratio'

  return (
    <div className="w-full space-y-8">
      {/* 页头：标题 + 一个问号，说明全部收进 tooltip */}
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Live Compact</h2>
        <SettingsHelpTip content={HEADER_HELP} label="Live Compact 工作原理" />
      </div>

      {/* 开关行：主闸与结束轮保护并排，窄屏堆叠 */}
      <SettingsCard divided={false}>
        <div className="grid divide-y divide-border/25 md:grid-cols-2 md:divide-x md:divide-y-0">
          <ToggleCell
            label="Live Compact"
            help={MASTER_HELP}
            helpLabel="全局主闸说明"
            checked={settings.enabled}
            disabled={saving || loading}
            onCheckedChange={(checked) => void updateEnabled(checked)}
          />
          <ToggleCell
            label="结束轮保护"
            help={PROTECT_HELP}
            helpLabel="结束轮保护说明"
            checked={protectCurrentTurn}
            disabled={protectSaving || loading}
            onCheckedChange={(checked) => void updateProtectCurrentTurn(checked)}
          />
        </div>
      </SettingsCard>

      {/* 阈值设置：左列上游 Origin 只读，右列自定义可编辑 */}
      <SettingsSection title="阈值设置">
        <SettingsCard>
          <SettingsSegmentedControl
            label="取值来源"
            value={source}
            onValueChange={(value) => void updateLineSource(value)}
            options={SOURCE_OPTIONS}
            disabled={loading || lineSaving}
          />

          <div className="grid divide-y divide-border/25 md:grid-cols-2 md:divide-x md:divide-y-0">
            {/* 左列：原算法（上游 Origin），永远只读 */}
            <div className={cn('min-w-0 transition-opacity', isCustom && 'opacity-55')}>
              <div className="flex items-center gap-1.5 px-4 pb-2 pt-3">
                <span className="text-sm font-medium text-foreground">原算法</span>
                <SettingsHelpTip content={ORIGIN_COLUMN_HELP} label="原算法取值说明" />
              </div>
              <div className="divide-y divide-border/25 border-t border-border/25">
                {LIVE_COMPACT_ORIGIN_LINE_ROWS.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-3 px-4 py-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm text-foreground">{row.label}</span>
                      <SettingsHelpTip content={describeOriginRow(row)} label={`${row.label}原算法说明`} />
                    </div>
                    <ReadonlyValue>
                      {formatTokenCount(row.value)} {row.unit}
                    </ReadonlyValue>
                  </div>
                ))}
              </div>
            </div>

            {/* 右列：自定义（比例 / 绝对值），非生效一侧灰框显示换算预览 */}
            <div className={cn('flex min-w-0 flex-col transition-opacity', !isCustom && 'opacity-55')}>
              <SettingsSegmentedControl
                label={(
                  <span className="inline-flex items-center gap-1.5">
                    自定义
                    <SettingsHelpTip content={CUSTOM_MODE_HELP} label="自定义取值说明" />
                  </span>
                )}
                value={customMode}
                onValueChange={(value) => setCustomMode(value === 'absolute' ? 'absolute' : 'ratio')}
                options={CUSTOM_MODE_OPTIONS}
                disabled={loading || !isCustom}
              />

              <div className="divide-y divide-border/25 border-t border-border/25">
                {LIVE_COMPACT_LINE_KEYS.map((key) => {
                  const error = validation.errors[key]
                  return (
                    <div key={key} className="px-4 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm text-foreground">
                            {LIVE_COMPACT_LINE_LABELS[key]}
                          </span>
                          <SettingsHelpTip
                            content={LINE_HELP[key][customMode]}
                            label={`${LIVE_COMPACT_LINE_LABELS[key]}自定义说明`}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Input
                            aria-label={`${LIVE_COMPACT_LINE_LABELS[key]}比例（%）`}
                            inputMode="decimal"
                            className="h-8 w-20 px-2 text-right text-sm tabular-nums"
                            value={ratioActive ? ratioDraft[key] : conversionText(key)}
                            onChange={(event) => setDraft('ratio', key, event.target.value)}
                            onKeyDown={handleLineKeyDown}
                            placeholder="50"
                            readOnly={!ratioActive}
                            disabled={loading || !isCustom || !ratioActive}
                            title="比例（%）"
                          />
                          <Input
                            aria-label={`${LIVE_COMPACT_LINE_LABELS[key]}绝对值（token）`}
                            inputMode="numeric"
                            className="h-8 w-24 px-2 text-right text-sm tabular-nums"
                            value={ratioActive ? conversionText(key) : absoluteDraft[key]}
                            onChange={(event) => setDraft('absolute', key, event.target.value)}
                            onKeyDown={handleLineKeyDown}
                            placeholder="20000"
                            readOnly={ratioActive}
                            disabled={loading || !isCustom || ratioActive}
                            title="绝对值（token）"
                          />
                        </div>
                      </div>
                      {error && <p className="mt-1 text-right text-xs text-destructive">{error}</p>}
                    </div>
                  )
                })}

                {/* 参考上下文长度：只服务非生效列的灰框预览，不参与保存 */}
                <div className="px-4 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm text-foreground">参考上下文长度</span>
                      <SettingsHelpTip content={PREVIEW_WINDOW_HELP} label="参考上下文长度说明" />
                    </div>
                    <Input
                      aria-label="参考上下文长度（token）"
                      inputMode="numeric"
                      className="h-8 w-32 shrink-0 px-2 text-right text-sm tabular-nums"
                      value={previewWindowDraft}
                      onChange={(event) => setPreviewWindowDraft(event.target.value)}
                      placeholder={String(PREVIEW_WINDOW_DEFAULT)}
                      disabled={loading || !isCustom}
                    />
                  </div>
                  {previewWindow.error && (
                    <p className="mt-1 text-right text-xs text-destructive">{previewWindow.error}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={loading || lineSaving || !isCustom || !validation.ok}
                    onClick={() => void saveLines()}
                  >
                    {lineSaving
                      ? <><Loader2 className="animate-spin" />正在保存…</>
                      : <><Check />保存</>}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || lineSaving || !isCustom}
                    onClick={resetLineDrafts}
                  >
                    <RotateCcw />
                    恢复默认值
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {isCustom
                      ? '保存后下一条消息生效；比例换算与主进程一致：Math.max(1, Math.round(窗口 × 占比))。'
                      : '原算法生效，切到「自定义」后可编辑。'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 算法更新：内置 / 当前生效 / 上游最新 + 检查、同步、回退 */}
      <SettingsSection
        title="算法更新"
        action={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void refreshState()}
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
            刷新状态
          </Button>
        )}
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
            <span className="inline-flex items-center gap-1">
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
              <SettingsHelpTip content={CHECK_HELP} label="检查上游说明" />
            </span>
            <span className="inline-flex items-center gap-1">
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
              <SettingsHelpTip content={SYNC_HELP} label="同步上游说明" />
            </span>
            {active && (
              <span className="inline-flex items-center gap-1">
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
                <SettingsHelpTip content={RESET_HELP} label="回退内置版本说明" />
              </span>
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
    </div>
  )
}
