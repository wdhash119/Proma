/**
 * Persona Atoms - 人设状态管理
 *
 * 人设库配置（主进程加载）、全局默认选择（新问答会话）、
 * per-conversation 选择（分屏/多问答会话独立）。
 * Agent 会话的人设选择持久化在 AgentSessionMeta.personaId，不走这里。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { BUILTIN_DEFAULT_PERSONA_ID, QA_BASELINE_SYSTEM_PROMPT, normalizePersonaConfig } from '@proma/shared'
import type { PersonaConfig, Persona } from '@proma/shared'

/** 完整人设配置（从主进程加载；初始值为内置种子） */
export const personaConfigAtom = atom<PersonaConfig>(normalizePersonaConfig(undefined))

/** 当前全局选中的人设 ID（新问答会话的默认值，持久化到 localStorage） */
export const selectedPersonaIdAtom = atomWithStorage<string>(
  'proma-selected-persona-id',
  BUILTIN_DEFAULT_PERSONA_ID
)

/** 人设列表（派生只读） */
export const personaListAtom = atom<Persona[]>(
  (get) => get(personaConfigAtom).personas
)

/** 默认人设 ID（派生只读） */
export const defaultPersonaIdAtom = atom<string>(
  (get) => get(personaConfigAtom).defaultPersonaId
)

/** 每个问答会话选中的人设 ID（分屏时独立） */
export const conversationPersonaIdAtom = atom<Map<string, string>>(new Map())

/**
 * 根据 personaId 解析问答 systemMessage（纯函数）。
 *
 * 默认助手人设正文为空，问答回到内置基线（QA_BASELINE_SYSTEM_PROMPT）；
 * 其他人设用自身正文，空正文（含人设不存在）返回 undefined。
 */
export function resolvePersonaSystemMessage(
  personaId: string,
  config: PersonaConfig,
): string | undefined {
  const persona = config.personas.find((item) => item.id === personaId)
  if (!persona) return undefined
  if (persona.id === BUILTIN_DEFAULT_PERSONA_ID) return QA_BASELINE_SYSTEM_PROMPT
  const body = persona.body.trim()
  return body || undefined
}
