import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_DEFAULT_PERSONA_ID,
  QA_BASELINE_SYSTEM_PROMPT,
  normalizePersonaConfig,
} from '@proma/shared'
import type { Persona } from '@proma/shared'
import { resolvePersonaSystemMessage } from './persona-atoms'

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'custom-1',
    name: '测试人设',
    description: '',
    body: '你是一名测试助手。',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('问答 systemMessage 解析', () => {
  test('Given 默认助手 When 解析 Then 返回侧栏问答内置基线', () => {
    const config = normalizePersonaConfig(undefined)
    expect(resolvePersonaSystemMessage(BUILTIN_DEFAULT_PERSONA_ID, config)).toBe(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given 自定义人设缺省（append） When 解析 Then 基线叠加人设段', () => {
    const config = normalizePersonaConfig({ personas: [makePersona({ body: '  证据优先。  ' })] })
    const message = resolvePersonaSystemMessage('custom-1', config)
    expect(message?.startsWith(QA_BASELINE_SYSTEM_PROMPT)).toBe(true)
    expect(message).toContain('## 人设：测试人设')
    expect(message).toContain('证据优先。')
    expect(message).toContain('安全契约')
  })

  test('Given 自定义人设显式 replace When 解析 Then 仅返回人设正文', () => {
    const config = normalizePersonaConfig({
      personas: [makePersona({ body: '  完整自定义系统提示词。  ', qaInjection: 'replace' })],
    })
    const message = resolvePersonaSystemMessage('custom-1', config)
    expect(message).toBe('完整自定义系统提示词。')
    expect(message).not.toContain(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given 自定义人设正文为空且 append When 解析 Then 回落内置基线', () => {
    const config = normalizePersonaConfig({ personas: [makePersona({ id: 'empty', body: '   ', qaInjection: 'append' })] })
    expect(resolvePersonaSystemMessage('empty', config)).toBe(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given 自定义人设正文为空且 replace When 解析 Then 返回 undefined', () => {
    const config = normalizePersonaConfig({ personas: [makePersona({ id: 'empty', body: '   ', qaInjection: 'replace' })] })
    expect(resolvePersonaSystemMessage('empty', config)).toBeUndefined()
  })

  test('Given 人设不存在 When 解析 Then 返回 undefined', () => {
    const config = normalizePersonaConfig(undefined)
    expect(resolvePersonaSystemMessage('missing', config)).toBeUndefined()
  })
})
