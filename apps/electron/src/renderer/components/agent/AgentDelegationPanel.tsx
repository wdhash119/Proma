/**
 * AgentDelegationPanel - 会话「委派策略」UI
 *
 * 两块导出：
 * - DelegationCheckbox：模型选择器搜索行最右端的「委派」复选框；勾选 = 启用策略
 *   （默认模式为「继承」），取消勾选 = 清除策略（回到默认模式）；
 * - DelegationPanel：模型选择器弹层扩展出的右栏，含模式、委派模型、运行上限、思考强度。
 *
 * 面板内所有控件即改即存，由宿主（AgentView）负责乐观更新与持久化；
 * 委派模型用固定显示的下拉框：继承模式展示禁用的当前主模型，指定模式可切换。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertTriangle, Minus, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { channelsAtom, channelsLoadedAtom } from '@/atoms/channel-atoms'
import { getModelLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { AgentDelegationPolicy, AgentThinkingLevel, Channel } from '@proma/shared'

/** 未设置思考强度时 Select 的占位值（Radix Select 不接受空字符串 value）。 */
const THINKING_LEVEL_UNSET = '__unset__'

/** 思考强度七档的中文标签，与 AgentView 工具栏的思考模式文案保持一致。 */
const THINKING_LEVEL_OPTIONS: readonly { value: AgentThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

/** 同时运行上限的允许区间，与主进程钳制口径一致。 */
const MAX_CONCURRENT_MIN = 1
const MAX_CONCURRENT_MAX = 50

/** 面板内的小节标题样式。 */
const SECTION_LABEL_CLASS = 'text-xs font-medium text-muted-foreground/80'
/** 面板内的说明文字样式。 */
const SECTION_HINT_CLASS = 'text-[11px] leading-relaxed text-muted-foreground/70'

/** 渠道是否参与委派模型候选：渠道启用且有至少一个启用的模型。 */
function isChannelSelectable(channel: Channel): boolean {
  return channel.enabled && channel.models.some((model) => model.enabled)
}

/** 策略指定的目标在渠道数据中是否仍然可用。 */
function isPolicyTargetAvailable(policy: AgentDelegationPolicy, channels: Channel[]): boolean {
  if (policy.mode !== 'specified' || !policy.channelId || !policy.modelId) return false
  const channel = channels.find((item) => item.id === policy.channelId)
  if (!channel || !channel.enabled) return false
  return channel.models.some((model) => model.id === policy.modelId && model.enabled)
}

/** 模型下拉的复合 value：channelId 与 modelId 用 :: 连接，避免跨渠道同 id 歧义。 */
function encodeModelValue(channelId: string, modelId: string): string {
  return `${channelId}::${modelId}`
}

function decodeModelValue(value: string): { channelId: string; modelId: string } | undefined {
  const separator = value.indexOf('::')
  if (separator <= 0) return undefined
  return { channelId: value.slice(0, separator), modelId: value.slice(separator + 2) }
}

interface DelegationCheckboxProps {
  /** 策略是否已启用（非默认模式） */
  enabled: boolean
  /** 勾选/取消回调；勾选时上层写入 { mode: 'inherit' }，取消时写入 null */
  onEnabledChange: (enabled: boolean) => void
  /** 委派子会话中禁用 */
  disabled?: boolean
  disabledReason?: string
}

/**
 * 「委派」复选框（搜索行最右端）。
 *
 * 用 button + role="checkbox" 实现，键盘 Enter/Space 可切换；
 * disabled 时包一层 span 承载 Tooltip（禁用按钮自身不派发鼠标事件）。
 */
export function DelegationCheckbox({
  enabled,
  onEnabledChange,
  disabled = false,
  disabledReason,
}: DelegationCheckboxProps): React.ReactElement {
  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={enabled}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onEnabledChange(!enabled)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/40'
          : 'text-muted-foreground/70 hover:text-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-3.5 items-center justify-center rounded-[4px] border transition-colors',
          enabled && !disabled
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-transparent',
          disabled && 'opacity-50',
        )}
      >
        {enabled ? (
          <svg viewBox="0 0 12 12" className="size-2.5" fill="none" aria-hidden="true">
            <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <span>委派</span>
    </button>
  )

  if (!disabled || !disabledReason) return checkbox

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 禁用态按钮不触发鼠标事件，用包一层 span 承担 Tooltip 的悬浮目标 */}
        <span className="inline-flex">{checkbox}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{disabledReason}</TooltipContent>
    </Tooltip>
  )
}

interface DelegationPanelProps {
  /** 当前策略（保证非 null；enabled 时才渲染本面板） */
  policy: AgentDelegationPolicy
  onChange: (policy: AgentDelegationPolicy) => void
  /** 当前会话的主模型（继承模式下拉框展示为禁用值）；缺失时显示「当前对话模型」占位 */
  currentModel?: { channelId: string; modelId: string; modelName: string }
}

/**
 * 委派设置右栏。
 *
 * 结构自上而下：标题说明 → 模式 segmented → 委派模型下拉（固定显示）→ 运行上限 → 思考强度 → 生效提示。
 * 面板整体限高、内部滚动，避免把整个弹层撑高。
 */
export function DelegationPanel({ policy, onChange, currentModel }: DelegationPanelProps): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  // 切到「指定」但尚未选好模型的过渡态：只影响本面板展示，不落库。
  // specified 缺 channelId/modelId 是无效策略，IPC 层会拒绝持久化。
  const isSpecified = policy.mode === 'specified'
  // 展示态直接由已落库的 mode 驱动：切「指定」时默认选中主模型并立即持久化，
  // 不再需要未选模型的本地过渡态。
  const isInherit = !isSpecified

  /** 当前指定的模型是否已不可用（仅在确实设置了渠道+模型时判断）。 */
  const targetMissing = isSpecified
    && Boolean(policy.channelId && policy.modelId)
    && !isPolicyTargetAvailable(policy, channels)

  const selectableChannels = React.useMemo(
    () => channels.filter(isChannelSelectable),
    [channels],
  )

  /** 切换模式：切到指定时默认选中当前主模型，立即落库；无主模型信息时退而选第一个可用模型。 */
  const handleModeChange = (mode: 'inherit' | 'specified'): void => {
    if (mode === policy.mode) return
    if (mode === 'specified') {
      if (policy.channelId && policy.modelId) {
        onChange({ ...policy, mode })
        return
      }
      if (currentModel) {
        onChange({ ...policy, mode, channelId: currentModel.channelId, modelId: currentModel.modelId })
        return
      }
      // 兑底：主模型信息缺失（渠道未加载等）时选第一个可用模型；都没有则保持继承不变。
      const firstChannel = selectableChannels[0]
      const firstModel = firstChannel?.models.find((model) => model.enabled)
      if (firstChannel && firstModel) {
        onChange({ ...policy, mode, channelId: firstChannel.id, modelId: firstModel.id })
      }
      return
    }
    onChange({ ...policy, mode })
  }

  const handleSelectModel = (value: string): void => {
    const decoded = decodeModelValue(value)
    if (!decoded) return
    onChange({ ...policy, mode: 'specified', channelId: decoded.channelId, modelId: decoded.modelId })
  }

  /** 上限输入：空串删除字段；数字钳制到 [1,50] 整数。 */
  const handleMaxConcurrentChange = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      const next = { ...policy }
      delete next.maxConcurrent
      onChange(next)
      return
    }
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(MAX_CONCURRENT_MAX, Math.max(MAX_CONCURRENT_MIN, parsed))
    onChange({ ...policy, maxConcurrent: clamped })
  }

  /** 步进器：未设置时从默认 50 起步；减到 1 / 加到 50 后对应按钮禁用。 */
  const handleMaxConcurrentStep = (delta: number): void => {
    const base = policy.maxConcurrent ?? MAX_CONCURRENT_MAX
    const clamped = Math.min(MAX_CONCURRENT_MAX, Math.max(MAX_CONCURRENT_MIN, base + delta))
    if (clamped === policy.maxConcurrent) return
    onChange({ ...policy, maxConcurrent: clamped })
  }

  /** 思考强度：未设置删除字段，其余写入档位。 */
  const handleThinkingLevelChange = (value: string): void => {
    if (value === THINKING_LEVEL_UNSET) {
      const next = { ...policy }
      delete next.thinkingLevel
      onChange(next)
      return
    }
    const level = THINKING_LEVEL_OPTIONS.find((option) => option.value === value)
    if (!level) return
    onChange({ ...policy, thinkingLevel: level.value })
  }

  /** 指定模式下拉的当前值：仅在目标仍在候选中时给出，失效/未选时显示占位。 */
  const specifiedValue = policy.channelId && policy.modelId && !targetMissing
    ? encodeModelValue(policy.channelId, policy.modelId)
    : undefined
  const missingTargetName = targetMissing ? (policy.modelId ?? '') : undefined

  return (
    <div className="flex h-full min-h-0 flex-col text-left">
      {/* 头部 */}
      <div className="shrink-0 border-b border-border/60 px-3.5 py-2.5">
        <div className="text-sm font-medium text-foreground">委派设置</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground/70">
          约束本会话发起的协作子 Agent
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto scrollbar-thin px-3.5 py-3">
        {/* 模式 */}
        <div className="flex flex-col gap-1.5">
          <span className={SECTION_LABEL_CLASS}>模式</span>
          <div
            role="radiogroup"
            aria-label="委派模型来源"
            className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5"
          >
            <button
              type="button"
              role="radio"
              aria-checked={isInherit}
              onClick={() => handleModeChange('inherit')}
              className={cn(
                'flex-1 rounded-[5px] px-2 py-1 text-xs transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
                isInherit
                  ? 'bg-background font-medium text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              继承
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isSpecified}
              onClick={() => handleModeChange('specified')}
              className={cn(
                'flex-1 rounded-[5px] px-2 py-1 text-xs transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
                isSpecified
                  ? 'bg-background font-medium text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              指定
            </button>
          </div>
          <span className={SECTION_HINT_CLASS}>
            {isInherit
              ? '子会话使用当前对话模型，不可更改'
              : '子会话固定使用下方选择的模型'}
          </span>
        </div>

        {/* 委派模型：固定显示的下拉框；继承模式禁用并展示主模型 */}
        <div className="flex flex-col gap-1.5">
          <span className={SECTION_LABEL_CLASS}>委派模型</span>
          {isInherit ? (
            <Select disabled value={currentModel ? encodeModelValue(currentModel.channelId, currentModel.modelId) : undefined}>
              <SelectTrigger
                aria-label="委派模型（继承当前对话模型）"
                className="h-8 w-full text-xs [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5"
              >
                <SelectValue placeholder="当前对话模型">
                  {currentModel ? (
                    <>
                      <img
                        src={getModelLogo(currentModel.modelId, channels.find((c) => c.id === currentModel.channelId)?.provider ?? 'openai')}
                        alt=""
                        className="size-3.5 shrink-0 rounded object-contain"
                      />
                      <span className="min-w-0 truncate">{currentModel.modelName}</span>
                    </>
                  ) : '当前对话模型'}
                </SelectValue>
              </SelectTrigger>
              {/* 禁用态不会展开，提供一个合法 value 对应项以保证 SelectValue 正常回显 */}
              {currentModel ? (
                <SelectContent>
                  <SelectItem value={encodeModelValue(currentModel.channelId, currentModel.modelId)}>
                    {currentModel.modelName}
                  </SelectItem>
                </SelectContent>
              ) : null}
            </Select>
          ) : (
            <>
              {targetMissing ? (
                <div className="flex items-start gap-1.5 rounded-md bg-yellow-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden="true" />
                  <span>指定的模型已被禁用或删除，委派时将回落默认模式</span>
                </div>
              ) : null}
              {!channelsLoaded ? (
                <div className="flex h-8 items-center rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground/70">
                  加载渠道中…
                </div>
              ) : selectableChannels.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
                  没有可用模型，请先在渠道设置中启用
                </div>
              ) : (
                <Select value={specifiedValue} onValueChange={handleSelectModel}>
                  <SelectTrigger
                    aria-label="选择委派模型"
                    className={cn(
                      'h-8 w-full text-xs [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5',
                      !specifiedValue && 'text-muted-foreground/70',
                    )}
                  >
                    <SelectValue placeholder={missingTargetName ? `${missingTargetName}（已不可用）` : '选择委派模型'}>
                      <ModelTriggerLabel
                        channelId={policy.channelId}
                        modelId={policy.modelId}
                        channels={channels}
                      />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-[280px]">
                    {selectableChannels.map((channel) => (
                      <SelectGroup key={channel.id}>
                        <SelectLabel className="text-[11px]">{channel.name}</SelectLabel>
                        {channel.models.filter((model) => model.enabled).map((model) => (
                          <SelectItem
                            key={`${channel.id}:${model.id}`}
                            value={encodeModelValue(channel.id, model.id)}
                            className="text-xs"
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <img
                                src={getModelLogo(model.id, channel.provider)}
                                alt=""
                                className="size-3.5 shrink-0 rounded object-contain"
                              />
                              <span className="min-w-0 truncate">{model.name}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}
        </div>

        {/* 同时运行上限：文本输入 + 自定义步进器，隐藏原生 spinner */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="delegation-max-concurrent" className={SECTION_LABEL_CLASS}>
            同时运行上限
          </label>
          <div
            className={cn(
              'flex h-8 w-full items-center rounded-md border border-border/60 bg-background/40 shadow-xs',
              'transition-[border-color,box-shadow,background-color] duration-150 ease-out',
              'hover:border-border focus-within:border-ring focus-within:bg-background focus-within:ring-4 focus-within:ring-ring/15',
            )}
          >
            <input
              id="delegation-max-concurrent"
              type="text"
              inputMode="numeric"
              placeholder="50"
              value={policy.maxConcurrent ?? ''}
              onChange={(event) => {
                // 只收数字，阻止非法字符进入；清空即回默认 50。
                const digits = event.target.value.replace(/[^0-9]/g, '')
                handleMaxConcurrentChange(digits)
              }}
              className={cn(
                'h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none',
                'placeholder:text-muted-foreground/70',
              )}
            />
            <div className="flex h-full shrink-0 items-center border-l border-border/40">
              <button
                type="button"
                aria-label="减少同时运行上限"
                disabled={(policy.maxConcurrent ?? MAX_CONCURRENT_MAX) <= MAX_CONCURRENT_MIN}
                onClick={() => handleMaxConcurrentStep(-1)}
                className={cn(
                  'flex h-full w-7 items-center justify-center text-muted-foreground/70 transition-colors',
                  'hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30',
                  'focus:outline-none focus-visible:bg-accent/70',
                )}
              >
                <Minus className="size-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="增加同时运行上限"
                disabled={(policy.maxConcurrent ?? MAX_CONCURRENT_MAX) >= MAX_CONCURRENT_MAX}
                onClick={() => handleMaxConcurrentStep(1)}
                className={cn(
                  'flex h-full w-7 items-center justify-center rounded-r-md text-muted-foreground/70 transition-colors',
                  'hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30',
                  'focus:outline-none focus-visible:bg-accent/70',
                )}
              >
                <Plus className="size-3" aria-hidden="true" />
              </button>
            </div>
          </div>
          <span className={SECTION_HINT_CLASS}>
            同时运行的子会话数量上限，不强制派满；留空为 50
          </span>
        </div>

        {/* 思考强度 */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="delegation-thinking-level" className={SECTION_LABEL_CLASS}>
            子会话思考强度
          </label>
          <Select
            value={policy.thinkingLevel ?? THINKING_LEVEL_UNSET}
            onValueChange={handleThinkingLevelChange}
          >
            <SelectTrigger id="delegation-thinking-level" className="h-8 text-xs">
              <SelectValue placeholder="未设置（跟随 Agent 选择）" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={THINKING_LEVEL_UNSET}>未设置（跟随 Agent 选择）</SelectItem>
              {THINKING_LEVEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className={SECTION_HINT_CLASS}>
            设置后委派的子会话固定使用该强度，Agent 无法覆盖。使用不支持思考的模型时建议选「关闭」。
          </span>
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 px-3.5 py-2">
        <span className={SECTION_HINT_CLASS}>修改于下一轮生效</span>
      </div>
    </div>
  )
}

/** 指定模式下拉触发器内的「logo + 模型名」回显；目标缺失时返回 null 交给 placeholder。 */
function ModelTriggerLabel({
  channelId,
  modelId,
  channels,
}: {
  channelId?: string
  modelId?: string
  channels: Channel[]
}): React.ReactElement | null {
  if (!channelId || !modelId) return null
  const channel = channels.find((item) => item.id === channelId)
  const model = channel?.models.find((item) => item.id === modelId)
  if (!channel || !model) return null
  return (
    <>
      <img
        src={getModelLogo(model.id, channel.provider)}
        alt=""
        className="size-3.5 shrink-0 rounded object-contain"
      />
      <span className="min-w-0 truncate">{model.name}</span>
    </>
  )
}
