/**
 * 项目指令会话状态的规范化。
 *
 * 状态来自本地会话 meta JSON，读取前统一校验：丢弃非法条目并截断上限，
 * 防止损坏配置或异常增长影响后续轮次的指令注入。
 */

import type {
  ProjectInstructionSessionState,
  ProjectInstructionSourceSnapshot,
} from '../types/agent'

/** 已交付来源键上限（FIFO 保留最近）；单会话指令文件数量远小于此。 */
const MAX_DELIVERED_KEYS = 256
/** 待注入来源上限；超出时保留最近激活的来源。 */
const MAX_PENDING_SOURCES = 16
/** legacy 守卫与提醒上限。 */
const MAX_LEGACY_ENTRIES = 64

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeSource(value: unknown): ProjectInstructionSourceSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const kind = source.kind
  if (kind !== 'agents' && kind !== 'claude') return undefined
  if (!isNonEmptyString(source.path)
    || !isNonEmptyString(source.relativePath)
    || !isNonEmptyString(source.scopeRoot)
    || !isNonEmptyString(source.contentHash)
    || typeof source.content !== 'string') {
    return undefined
  }
  return {
    path: source.path,
    relativePath: source.relativePath,
    scopeRoot: source.scopeRoot,
    kind,
    content: source.content,
    contentHash: source.contentHash,
  }
}

function normalizeStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isNonEmptyString).slice(-max)
}

/** 规范化会话状态；无任何有效内容时返回 undefined（等价于全新会话）。 */
export function normalizeProjectInstructionSessionState(value: unknown): ProjectInstructionSessionState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const deliveredKeys = normalizeStringArray(source.deliveredKeys, MAX_DELIVERED_KEYS)
  const pendingSources = (Array.isArray(source.pendingSources) ? source.pendingSources : [])
    .map(normalizeSource)
    .filter((entry): entry is ProjectInstructionSourceSnapshot => entry !== undefined)
    .slice(-MAX_PENDING_SOURCES)
  const consumedLegacyMigrations = normalizeStringArray(source.consumedLegacyMigrations, MAX_LEGACY_ENTRIES)
  const pendingLegacyReminders = (Array.isArray(source.pendingLegacyReminders) ? source.pendingLegacyReminders : [])
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const reminder = entry as Record<string, unknown>
      if (!isNonEmptyString(reminder.sourcePath) || !isNonEmptyString(reminder.text)) return []
      return [{ sourcePath: reminder.sourcePath, text: reminder.text }]
    })
    .slice(-MAX_LEGACY_ENTRIES)
  if (deliveredKeys.length === 0 && pendingSources.length === 0
    && consumedLegacyMigrations.length === 0 && pendingLegacyReminders.length === 0) {
    return undefined
  }
  return { deliveredKeys, pendingSources, consumedLegacyMigrations, pendingLegacyReminders }
}