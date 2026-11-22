import * as React from 'react'
import { Eye, ShieldCheck } from 'lucide-react'
import type { VisionRelayMode, VisionRelaySettings as VisionRelaySettingsValue } from '@/types/settings'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { SettingsCard, SettingsRow, SettingsSection, SettingsSegmentedControl } from './primitives'

const DEFAULT_SETTINGS: VisionRelaySettingsValue = { mode: 'off' }

const MODE_OPTIONS: Array<{ value: VisionRelayMode; label: string }> = [
  { value: 'off', label: '禁止' },
  { value: 'auto', label: '自动' },
  { value: 'force', label: '强制' },
]

/** 挡位说明：离开设置页即无需回看，因此文案直接写清运行时行为。 */
const MODE_DESCRIPTIONS: Record<VisionRelayMode, string> = {
  off: '完全不参与。不注入视觉工具，也不接管 Read；已选模型仅作保留，便于再次开启。',
  auto: '当前模型已确认支持图片输入时完全原生，不提供视觉工具；模型不支持或能力未确认时，额外提供视觉助手工具，由 Agent 按需调用。',
  force: '不依赖当前模型能力。所有模型的 Read 图片都会被交给下方视觉模型，当前模型只收到文本 JSON。',
}

/** 各挡位下当前模型实际收到什么；不把未被拦截的原生图片行为说成已被接管。 */
const MODEL_RECEIVE_DESCRIPTIONS: Record<VisionRelayMode, string> = {
  off: '视觉助手不产生请求，当前模型按自身默认行为处理图片。',
  auto: '自动档不拦截当前模型的原生图片行为：模型已支持图片输入时图片直接进入对话；不支持或能力未确认时，Agent 才可能调用助手，经助手处理的图片只发送给所选视觉模型，结果以文本 JSON 返回。',
  force: '强制档下 Read 图片一律先交给所选视觉模型，当前模型只收到返回的文本 JSON，图片不会作为附件进入对话上下文。',
}

/** 视觉助手设置：禁止 / 自动 / 强制三挡位 + 独立视觉模型路由。 */
export function VisionRelaySettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<VisionRelaySettingsValue>(DEFAULT_SETTINGS)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    window.electronAPI.getSettings()
      .then((appSettings) => setSettings(appSettings.visionRelay ?? DEFAULT_SETTINGS))
      .catch(console.error)
  }, [])

  const save = async (next: VisionRelaySettingsValue): Promise<void> => {
    const previous = settings
    setSettings(next)
    setSaving(true)
    try {
      await window.electronAPI.updateSettings({ visionRelay: next })
    } catch (error) {
      console.error('[视觉助手设置] 保存失败:', error)
      setSettings(previous)
    } finally {
      setSaving(false)
    }
  }

  const selectedModel = settings.channelId && settings.modelId
    ? { channelId: settings.channelId, modelId: settings.modelId }
    : null
  const configured = Boolean(selectedModel)
  const activeMode = settings.mode !== 'off'
  // 开启挡位但没选完整路由时，运行时不会生效；必须明确告知，而不是假装已接管。
  const pendingRoute = activeMode && !configured

  const modeRowDescription = pendingRoute
    ? `${MODE_DESCRIPTIONS[settings.mode]}当前尚未生效：还需要选择下方的视觉模型。`
    : MODE_DESCRIPTIONS[settings.mode]

  return (
    <div className="space-y-8">
      <SettingsSection
        title="视觉助手"
        description="为缺少原生视觉能力的模型接入独立的视觉模型路由，具体外发条件由下方挡位决定。"
      >
        <SettingsCard>
          <SettingsSegmentedControl
            label="视觉助手挡位"
            description={modeRowDescription}
            value={settings.mode}
            disabled={saving}
            options={MODE_OPTIONS}
            onValueChange={(value) => void save({ ...settings, mode: value as VisionRelayMode })}
          />
          <SettingsRow
            label="视觉模型"
            icon={<Eye className="size-4 text-violet-500" />}
            description={activeMode
              ? '选择已有渠道中的视觉模型。Proma 继续复用该渠道加密保存的 API Key。'
              : '已保留上次选择的模型；挡位开启后立即生效。'}
          >
            <ModelSelector
              externalSelectedModel={selectedModel}
              excludedProviders={['openai-codex', 'github-copilot', 'xai']}
              showChannelInTrigger
              onModelSelect={(model) => void save({
                ...settings,
                channelId: model.channelId,
                modelId: model.modelId,
              })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="隐私边界" description="视觉助手遵循最小外发原则。">
        <SettingsCard>
          <SettingsRow
            label="何时会把图片外发给视觉模型"
            icon={<ShieldCheck className="size-4 text-emerald-500" />}
            description={activeMode
              ? '仅在挡位开启且已选好渠道与模型时才授权：自动档仅在当前模型不支持或能力未确认、且 Agent 主动调用助手时，把当前会话或用户已附加目录中的 PNG、JPEG、GIF、WebP 图片与最多 1000 字符的视觉问题发送给所选模型，单张上限 10MB；强制档对所有 Read 图片都这样做。'
              : '当前为禁止挡位：不注入视觉工具、不接管 Read，也不会向视觉模型发送任何图片或问题。'}
          />
          <SettingsRow
            label="当前模型能收到什么"
            description={MODEL_RECEIVE_DESCRIPTIONS[settings.mode]}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
