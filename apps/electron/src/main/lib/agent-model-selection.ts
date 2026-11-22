import { getChannelById } from './channel-manager'

export function assertEnabledModelForChannel(input: {
  channelId?: string
  modelId?: string
  purpose: string
}): string | undefined {
  if (input.modelId == null) return undefined

  const modelId = input.modelId.trim()
  if (!modelId) {
    throw new Error(`${input.purpose}模型 ID 不能为空`)
  }
  if (!input.channelId) {
    throw new Error(`${input.purpose}需要可用的 channelId`)
  }

  const channel = getChannelById(input.channelId)
  if (!channel || !channel.enabled) {
    throw new Error(`${input.purpose}引用的渠道不存在或未启用: ${input.channelId}`)
  }

  const model = channel.models.find((item) => item.id === modelId && item.enabled)
  if (!model) {
    throw new Error(`${input.purpose}模型不属于当前渠道或未启用: ${modelId}`)
  }

  return modelId
}
