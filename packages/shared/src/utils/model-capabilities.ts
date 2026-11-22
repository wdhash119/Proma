/**
 * 模型能力手动覆盖的规范化。
 *
 * 渠道配置来自本地 JSON 与渲染进程 IPC，写入与消费前统一校验：
 * 非法字段丢弃，全部无效时返回 undefined（等价于跟随自动检测）。
 */

import type { ModelCapabilityOverrides } from '../types/channel'

/** token 数上限：防御异常配置把上下文/输出撑到不合理的量级。 */
const MAX_TOKEN_VALUE = 100_000_000

function normalizeTokenValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  if (rounded <= 0 || rounded > MAX_TOKEN_VALUE) return undefined
  return rounded
}

/** 规范化手动能力覆盖；无有效字段时返回 undefined。 */
export function normalizeModelCapabilityOverrides(value: unknown): ModelCapabilityOverrides | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const result: ModelCapabilityOverrides = {}
  const contextWindow = normalizeTokenValue(source.contextWindow)
  if (contextWindow !== undefined) result.contextWindow = contextWindow
  const maxOutputTokens = normalizeTokenValue(source.maxOutputTokens)
  if (maxOutputTokens !== undefined) result.maxOutputTokens = maxOutputTokens
  if (typeof source.imageInput === 'boolean') result.imageInput = source.imageInput
  if (typeof source.reasoning === 'boolean') result.reasoning = source.reasoning
  return Object.keys(result).length > 0 ? result : undefined
}

/** 是否存在有效的手动能力覆盖。 */
export function hasModelCapabilityOverrides(value: ModelCapabilityOverrides | undefined): boolean {
  return normalizeModelCapabilityOverrides(value) !== undefined
}