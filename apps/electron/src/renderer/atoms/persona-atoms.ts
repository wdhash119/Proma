/**
 * Persona Atoms - 人设配置状态
 *
 * 仅维护人设库配置与默认人设（设置页、新建 Agent 会话的默认值）。
 * Agent 会话的人设选择持久化在 AgentSessionMeta.personaId，不走这里；
 * Chat 专属的「问答会话人设」状态已随 Chat 退役删除。
 */

import { atom } from 'jotai'
import { normalizePersonaConfig } from '@proma/shared'
import type { PersonaConfig } from '@proma/shared'

/** 完整人设配置（从主进程加载；初始值为内置种子） */
export const personaConfigAtom = atom<PersonaConfig>(normalizePersonaConfig(undefined))

/** 默认人设 ID（派生只读） */
export const defaultPersonaIdAtom = atom<string>(
  (get) => get(personaConfigAtom).defaultPersonaId
)
