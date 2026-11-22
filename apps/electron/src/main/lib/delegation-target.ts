/**
 * 协作子会话的渠道/模型解析。
 *
 * 默认继承父会话的渠道与模型；显式指定时才跨渠道，用于「让这个子任务用另一家模型」。
 * 解析只决定用哪个渠道，凭据仍由 `agent-orchestrator` 按 provider 分支解析，
 * 因此不需要在这里接触 API Key。
 *
 * 冲突策略：同一 modelId 出现在多个启用渠道时不猜，要求显式给 channelId。
 */

import type { ProviderType } from '@proma/shared'

/** 解析所需的最小渠道视图，便于测试注入。 */
export interface DelegationChannelView {
  id: string
  name: string
  provider: ProviderType
  enabled: boolean
  models: Array<{ id: string; name: string; enabled: boolean }>
}

interface DelegationTargetRequest {
  /** 子会话父级的渠道；未跨渠道时继承。 */
  parentChannelId: string
  /** 子会话父级的模型；未跨渠道时继承。 */
  parentModelId?: string
  /** 显式指定的目标渠道。 */
  channelId?: string
  /** 显式指定的目标模型。 */
  modelId?: string
}

interface DelegationTarget {
  channelId: string
  channelName: string
  provider: ProviderType
  /** 未指定 modelId 且渠道有默认模型时为该模型；否则为 undefined 表示沿用渠道默认。 */
  modelId?: string
  /** 是否发生了跨渠道（用于日志与提示）。 */
  crossChannel: boolean
}

export class DelegationTargetError extends Error {}

function enabledModels(channel: DelegationChannelView): Array<{ id: string; name: string }> {
  return channel.models.filter((model) => model.enabled).map((model) => ({ id: model.id, name: model.name }))
}

/**
 * 解析子会话应使用的渠道与模型。
 *
 * 四种组合：
 * - 都没给：继承父会话（channelId 与 modelId）
 * - 只给 channelId：用该渠道，模型取该渠道唯一/第一个启用模型
 * - 只给 modelId：在全部启用渠道里找唯一归属，歧义则报错
 * - 都给了：校验模型属于该渠道且启用
 */
export function resolveDelegationTarget(
  request: DelegationTargetRequest,
  channels: DelegationChannelView[],
): DelegationTarget {
  const parentChannel = channels.find((channel) => channel.id === request.parentChannelId)
  if (!parentChannel) {
    throw new DelegationTargetError(`父会话渠道不存在: ${request.parentChannelId}`)
  }

  const requestedChannelId = request.channelId?.trim() || undefined
  const requestedModelId = request.modelId?.trim() || undefined

  // 情况一：完全继承。
  if (!requestedChannelId && !requestedModelId) {
    return {
      channelId: parentChannel.id,
      channelName: parentChannel.name,
      provider: parentChannel.provider,
      modelId: request.parentModelId?.trim() || undefined,
      crossChannel: false,
    }
  }

  // 情况四：渠道与模型都显式给出。
  if (requestedChannelId && requestedModelId) {
    const channel = channels.find((item) => item.id === requestedChannelId)
    if (!channel || !channel.enabled) {
      throw new DelegationTargetError(`指定渠道不存在或未启用: ${requestedChannelId}`)
    }
    if (!enabledModels(channel).some((model) => model.id === requestedModelId)) {
      throw new DelegationTargetError(`模型不属于指定渠道或未启用: ${requestedModelId}（渠道 ${channel.name}）`)
    }
    return {
      channelId: channel.id,
      channelName: channel.name,
      provider: channel.provider,
      modelId: requestedModelId,
      crossChannel: channel.id !== parentChannel.id,
    }
  }

  // 情况二：只给渠道，模型取该渠道可用模型。
  if (requestedChannelId) {
    const channel = channels.find((item) => item.id === requestedChannelId)
    if (!channel || !channel.enabled) {
      throw new DelegationTargetError(`指定渠道不存在或未启用: ${requestedChannelId}`)
    }
    const models = enabledModels(channel)
    if (models.length === 0) {
      throw new DelegationTargetError(`指定渠道没有启用的模型: ${channel.name}`)
    }
    return {
      channelId: channel.id,
      channelName: channel.name,
      provider: channel.provider,
      modelId: models[0]?.id,
      crossChannel: channel.id !== parentChannel.id,
    }
  }

  // 情况三：只给模型，在全渠道里找唯一归属。
  const owners = channels.filter(
    (channel) => channel.enabled && enabledModels(channel).some((model) => model.id === requestedModelId),
  )
  if (owners.length === 0) {
    throw new DelegationTargetError(`没有启用渠道提供该模型: ${requestedModelId}`)
  }
  if (owners.length > 1) {
    const names = owners.map((channel) => `${channel.name}(${channel.id})`).join('、')
    throw new DelegationTargetError(
      `模型 ${requestedModelId} 属于多个启用渠道，请显式指定 channelId：${names}`,
    )
  }
  const owner = owners[0]!
  return {
    channelId: owner.id,
    channelName: owner.name,
    provider: owner.provider,
    modelId: requestedModelId,
    crossChannel: owner.id !== parentChannel.id,
  }
}

/** 列出所有启用渠道的可用模型，供 `list_available_agent_models` 跨渠道展示。 */
interface AvailableAgentModelsAcrossChannels {
  currentChannelId: string
  currentModelId?: string
  currentModelAvailable: boolean
  channels: Array<{
    channelId: string
    channelName: string
    provider: ProviderType
    models: Array<{ id: string; name: string; current: boolean }>
  }>
  modelCount: number
  note: string
}

export function listAvailableAgentModelsAcrossChannels(
  currentChannelId: string | undefined,
  currentModelId: string | undefined,
  channels: DelegationChannelView[],
): AvailableAgentModelsAcrossChannels {
  const modelId = currentModelId?.trim() || undefined
  const enabled = channels.filter((channel) => channel.enabled)

  const view = enabled.map((channel) => ({
    channelId: channel.id,
    channelName: channel.name,
    provider: channel.provider,
    models: enabledModels(channel).map((model) => ({
      id: model.id,
      name: model.name,
      current: channel.id === currentChannelId && model.id === modelId,
    })),
  }))

  const modelCount = view.reduce((total, channel) => total + channel.models.length, 0)
  const currentModelAvailable = view.some((channel) => channel.models.some((model) => model.current))

  return {
    currentChannelId: currentChannelId ?? '',
    currentModelId: modelId,
    currentModelAvailable,
    channels: view,
    modelCount,
    note: modelCount > 0
      ? '默认继承父会话渠道与模型。需要让子任务改用其它供应商时，显式传 channelId 与 modelId；只传 modelId 时会在所有启用渠道中查找唯一归属。'
      : '当前没有任何启用渠道提供可用的 Agent 模型，请先在渠道设置中启用。',
  }
}
