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

  test('Given 自定义人设 When 解析 Then 返回其人设正文', () => {
    const config = normalizePersonaConfig({ personas: [makePersona({ body: '  证据优先。  ' })] })
    expect(resolvePersonaSystemMessage('custom-1', config)).toBe('证据优先。')
  })

  test('Given 自定义人设正文为空 When 解析 Then 返回 undefined', () => {
    const config = normalizePersonaConfig({ personas: [makePersona({ id: 'empty', body: '   ' })] })
    expect(resolvePersonaSystemMessage('empty', config)).toBeUndefined()
  })

  test('Given 人设不存在 When 解析 Then 返回 undefined', () => {
    const config = normalizePersonaConfig(undefined)
    expect(resolvePersonaSystemMessage('missing', config)).toBeUndefined()
  })
})
