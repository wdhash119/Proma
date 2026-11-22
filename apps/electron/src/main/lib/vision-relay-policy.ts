/**
 * 视觉助手运行策略（纯函数，无副作用）。
 *
 * 设置归一化与“是否注入 / 是否接管 Read”的判定集中在这里，避免 IPC、工具注入和
 * Read 包装各自实现一套近似规则。旧配置的 `enabled` 只在本模块边界迁移一次，
 * 运行逻辑只读取有效 `mode`。
 */

import type { VisionRelayMode, VisionRelaySettings } from '../../types/settings'

export type { VisionRelayMode, VisionRelaySettings }

/** 视觉助手可能出现的触发来源；automation / delegation 属于无人值守来源。 */
export type VisionRelayTrigger = 'user' | 'automation' | 'delegation' | 'external'

const VALID_MODES: readonly VisionRelayMode[] = ['off', 'auto', 'force']

/** 只接受非空字符串 ID；空白与非法类型一律丢弃。 */
function normalizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeMode(raw: Record<string, unknown>): VisionRelayMode {
  if (typeof raw.mode === 'string') {
    const trimmed = raw.mode.trim()
    if ((VALID_MODES as readonly string[]).includes(trimmed)) return trimmed as VisionRelayMode
  }
  // 旧配置迁移：仅显式 enabled: true 视为自动档，false 与缺失都视为关闭。
  return raw.enabled === true ? 'auto' : 'off'
}

/**
 * 归一化视觉助手设置。
 *
 * 有效 `mode` 优先于遗留 `enabled`；无法识别的 mode 按旧字段迁移，避免非法 IPC
 * 写入把开关落到不可预期的挡位。返回值不再携带 `enabled`。
 */
export function normalizeVisionRelaySettings(input: unknown): VisionRelaySettings {
  const raw = input !== null && typeof input === 'object'
    ? input as Record<string, unknown>
    : {}
  const settings: VisionRelaySettings = { mode: normalizeMode(raw) }
  const channelId = normalizeId(raw.channelId)
  const modelId = normalizeId(raw.modelId)
  if (channelId !== undefined) settings.channelId = channelId
  if (modelId !== undefined) settings.modelId = modelId
  return settings
}

/** 是否已选好完整的视觉路由（渠道 + 模型）。off 下也允许保留路由。 */
export function isVisionRelayRouteConfigured(settings: VisionRelaySettings | undefined): boolean {
  return normalizeId(settings?.channelId) !== undefined && normalizeId(settings?.modelId) !== undefined
}

/** 定时任务与协作子 Agent 无人值守，不允许把图片外发给视觉模型。 */
function isUnattendedTrigger(triggeredBy: VisionRelayTrigger | undefined): boolean {
  return triggeredBy === 'automation' || triggeredBy === 'delegation'
}

/**
 * 是否向当前会话注入 `VisionRelay` 工具。
 *
 * - off：永不注入。
 * - auto：仅当当前模型图片输入能力不是 `supported`（含 unknown 保守兜底）时注入。
 * - force：不依赖当前模型能力，始终注入。
 *
 * 两种开启挡位都要求路由完整，且排除无人值守来源。
 */
export function shouldInjectVisionRelayTool(input: {
  settings: VisionRelaySettings | undefined
  imageInput: 'supported' | 'unsupported' | 'unknown'
  triggeredBy?: VisionRelayTrigger
}): boolean {
  const mode = input.settings?.mode ?? 'off'
  if (mode === 'off') return false
  if (isUnattendedTrigger(input.triggeredBy)) return false
  if (!isVisionRelayRouteConfigured(input.settings)) return false
  if (mode === 'force') return true
  return input.imageInput !== 'supported'
}

/**
 * 是否用视觉中转包装 `Read` 的图片结果。
 *
 * 仅强制档要求接管；自动档依赖工具注入，不接管 Read。
 */
export function shouldForceVisionRelayRead(input: {
  settings: VisionRelaySettings | undefined
  triggeredBy?: VisionRelayTrigger
}): boolean {
  if ((input.settings?.mode ?? 'off') !== 'force') return false
  if (isUnattendedTrigger(input.triggeredBy)) return false
  return isVisionRelayRouteConfigured(input.settings)
}
