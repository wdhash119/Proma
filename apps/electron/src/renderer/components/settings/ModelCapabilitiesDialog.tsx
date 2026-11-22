/**
 * ModelCapabilitiesDialog - 模型能力手动设置
 *
 * 模型未被内置目录收录、无法自动检测时，运行时会回落保守默认值。
 * 这里允许用户按供应商文档手动修正：上下文长度、最大输出、图片输入、推理（思考）能力。
 * 修改即时写回渠道配置（编辑模式由表单 auto-save 持久化）；
 * 数值留空、开关选「自动」即跟随自动检测。
 *
 * 音频/视频输入目前不在运行时支持范围内（Pi 仅 text/image），不做无效开关；
 * 语音通过「语音输入」转写为文本后发送。
 */

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { normalizeModelCapabilityOverrides } from '@proma/shared'
import type { ChannelModel, ModelCapabilityOverrides, ModelCapabilitySummary, ProviderType } from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsInput, SettingsSegmentedControl } from './primitives'

interface ModelCapabilitiesDialogProps {
  /** 当前编辑的模型；null 表示关闭 */
  model: ChannelModel | null
  provider: ProviderType
  onClose: () => void
  /** 写回能力覆盖；undefined 表示恢复完全自动检测 */
  onChange: (modelId: string, capabilities: ModelCapabilityOverrides | undefined) => void
}

type TriStateMode = 'auto' | 'on' | 'off'

const TRI_STATE_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'on', label: '支持' },
  { value: 'off', label: '不支持' },
]

const REASONING_STATE_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'on', label: '启用' },
  { value: 'off', label: '禁用' },
]

/** token 数上限，与 shared 规范化保持一致。 */
const MAX_TOKEN_VALUE = 100_000_000

function formatTokenCount(value: number): string {
  return value.toLocaleString('en-US')
}

function toMode(value: boolean | undefined): TriStateMode {
  if (value === undefined) return 'auto'
  return value ? 'on' : 'off'
}

export function ModelCapabilitiesDialog({
  model,
  provider,
  onClose,
  onChange,
}: ModelCapabilitiesDialogProps): React.ReactElement {
  const modelId = model?.id ?? null
  const [summary, setSummary] = React.useState<ModelCapabilitySummary | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [contextWindowInput, setContextWindowInput] = React.useState('')
  const [maxOutputInput, setMaxOutputInput] = React.useState('')
  const [imageInputMode, setImageInputMode] = React.useState<TriStateMode>('auto')
  const [reasoningMode, setReasoningMode] = React.useState<TriStateMode>('auto')
  const [tokenError, setTokenError] = React.useState<string | null>(null)

  // 切换模型时重置草稿并拉取自动检测摘要。
  React.useEffect(() => {
    if (!modelId) return
    const capabilities = model?.capabilities
    setContextWindowInput(capabilities?.contextWindow !== undefined ? String(capabilities.contextWindow) : '')
    setMaxOutputInput(capabilities?.maxOutputTokens !== undefined ? String(capabilities.maxOutputTokens) : '')
    setImageInputMode(toMode(capabilities?.imageInput))
    setReasoningMode(toMode(capabilities?.reasoning))
    setTokenError(null)
    setSummary(null)
    setLoading(true)
    let cancelled = false
    window.electronAPI.resolveModelCapabilities(provider, modelId)
      .then((result) => { if (!cancelled) setSummary(result) })
      .catch((error) => {
        console.warn('[模型能力设置] 读取自动检测摘要失败:', error)
        if (!cancelled) setSummary(null)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // 仅在切换模型时重置草稿；能力写回引起的 model 更新不重置输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, provider])

  /** 合并单个字段到当前覆盖并写回；undefined 值表示移除该字段。 */
  const commitPatch = (patch: Partial<Record<keyof ModelCapabilityOverrides, number | boolean | undefined>>): void => {
    if (!model) return
    const next: Record<string, number | boolean | undefined> = { ...model.capabilities }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    onChange(model.id, normalizeModelCapabilityOverrides(next))
  }

  /** 数值输入失焦/回车时提交；非法值保留输入并提示，不写回。 */
  const commitTokenField = (field: 'contextWindow' | 'maxOutputTokens', raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      setTokenError(null)
      commitPatch({ [field]: undefined })
      return
    }
    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TOKEN_VALUE) {
      setTokenError('请输入不超过 100,000,000 的正数（token 数）')
      return
    }
    setTokenError(null)
    commitPatch({ [field]: Math.floor(value) })
  }

  const handleRestoreAuto = (): void => {
    if (!model) return
    setContextWindowInput('')
    setMaxOutputInput('')
    setImageInputMode('auto')
    setReasoningMode('auto')
    setTokenError(null)
    onChange(model.id, undefined)
  }

  const hasOverrides = normalizeModelCapabilityOverrides(model?.capabilities) !== undefined
  const autoContextLabel = summary ? `自动：${formatTokenCount(summary.contextWindow)}` : '自动'
  const autoMaxOutputLabel = summary ? `自动：${formatTokenCount(summary.maxOutputTokens)}` : '自动'
  const imageAutoDescription = summary
    ? summary.imageInput === undefined
      ? '自动检测无法确认，建议按供应商文档手动指定'
      : `自动检测：${summary.imageInput ? '支持' : '不支持'}`
    : undefined
  const reasoningAutoDescription = summary
    ? summary.reasoning === undefined
      ? '自动检测无法确认，建议按供应商文档手动指定'
      : `自动检测：${summary.reasoning ? '支持推理' : '不支持推理'}`
    : undefined

  return (
    <Dialog open={model !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>模型能力设置</DialogTitle>
          <DialogDescription>
            {model ? `${model.name}${model.name !== model.id ? `（${model.id}）` : ''}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          {/* 自动检测状态 */}
          <div className="px-1 pb-1 text-xs">
            {loading ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                正在读取自动检测结果…
              </span>
            ) : summary?.detected ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                已通过内置模型目录识别，以下为检测默认值，可手动覆盖。
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                未收录于内置模型目录，当前使用回落默认值。建议对照供应商文档核对后手动修正。
              </span>
            )}
          </div>

          <SettingsInput
            label="上下文长度（token）"
            description={model?.capabilities?.contextWindow !== undefined
              ? '手动值生效中；留空恢复自动检测'
              : '留空跟随自动检测'}
            value={contextWindowInput}
            onChange={setContextWindowInput}
            onBlur={() => commitTokenField('contextWindow', contextWindowInput)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
            placeholder={autoContextLabel}
            type="text"
            error={tokenError ?? undefined}
          />
          <SettingsInput
            label="最大输出（token）"
            description={model?.capabilities?.maxOutputTokens !== undefined
              ? '手动值生效中；留空恢复自动检测'
              : '留空跟随自动检测'}
            value={maxOutputInput}
            onChange={setMaxOutputInput}
            onBlur={() => commitTokenField('maxOutputTokens', maxOutputInput)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
            placeholder={autoMaxOutputLabel}
            type="text"
          />
          <SettingsSegmentedControl
            label="图片输入"
            description={imageAutoDescription}
            value={imageInputMode}
            onValueChange={(value) => {
              const mode = value as TriStateMode
              setImageInputMode(mode)
              commitPatch({ imageInput: mode === 'auto' ? undefined : mode === 'on' })
            }}
            options={TRI_STATE_OPTIONS}
          />
          <SettingsSegmentedControl
            label="推理（思考）能力"
            description={reasoningAutoDescription}
            value={reasoningMode}
            onValueChange={(value) => {
              const mode = value as TriStateMode
              setReasoningMode(mode)
              commitPatch({ reasoning: mode === 'auto' ? undefined : mode === 'on' })
            }}
            options={REASONING_STATE_OPTIONS}
          />

          <p className="px-4 pt-1 text-xs text-muted-foreground">
            音频与视频输入暂不在运行时支持范围内；语音可通过「语音输入」转写为文本后发送。
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" size="sm" type="button" onClick={handleRestoreAuto} disabled={!hasOverrides}>
            恢复自动检测
          </Button>
          <Button size="sm" type="button" onClick={onClose}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}