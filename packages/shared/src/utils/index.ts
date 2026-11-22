/**
 * Shared utility functions for proma
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export {
  createAgentRuntimeRequest,
  createAgentRuntimeResponse,
  isAgentRuntimeEnvelope,
  serializeAgentRuntimeError,
} from './agent-runtime'

export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_54_55_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  CODEX_GPT_6_CONTEXT_WINDOW,
  inferCodexAlignedGPT5ContextWindow,
  inferContextWindow,
  isMimoV26Model,
} from './context-window'
export {
  isGpt6AstraFamily,
  isGpt6SolFamily,
  isGpt6LunaFamily,
} from './model-family'
export { calculateContextUsageRatio } from './context-usage'
export {
  getGeminiModelCapability,
  normalizeGeminiThinkingLevel,
  type GeminiThinkingLevel,
} from './gemini-model-capabilities'
export {
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
} from './pi-compaction'
export {
  inferMcpTransportType,
  normalizeMcpTransportType,
} from './mcp-transport'
export { removeMcpServerFromConfig } from './mcp-config'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
} from './thinking-signature-error'
export { normalizePathForCompare } from './normalize-path'
export {
  MAX_NORMALIZED_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_SOURCE_LENGTH,
  findBestSearchMatch,
  findBestSearchMatchInNormalized,
  normalizeSearchText,
  createSearchSnippet,
  insertTopSearchResult,
  type NormalizedSearchText,
} from './search-matching'
export {
  AUTOMATION_OCCURRENCE_SAMPLES_PER_DAY,
  getAutomationOccurrencesByDay,
} from './automation-schedule'
export type {
} from './automation-schedule'
export {
  getSDKCompactStatus,
  isPersistableSDKSystemMessage,
} from './agent-system-message'
export {
  createSkillActivationFromPath,
  mergeSkillActivations,
  collectSkillActivations,
} from './skill-usage'
export {
  normalizeModelCapabilityOverrides,
  hasModelCapabilityOverrides,
} from './model-capabilities'
export { normalizeProjectInstructionSessionState } from './project-instruction-state'
