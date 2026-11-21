import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_DEFAULT_PERSONA_ID,
  BUILTIN_PERSONAS,
  MAX_PRIMER_TURNS,
  QA_BASELINE_SYSTEM_PROMPT,
  buildPersonaPromptSection,
  buildQaSystemMessage,
  normalizePersonaConfig,
  normalizePrimerTurns,
  normalizeQaInjection,
  parsePersonaMarkdown,
  resolveSessionPersona,
  sanitizePersonaId,
  serializePersonaMarkdown,
  type Persona,
} from './persona'

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

describe('人设 ID 与示范轮归一化', () => {
  test('Given 非法字符与大小写 When 规范化 ID Then 转为小写合法字符', () => {
    expect(sanitizePersonaId('My Persona!@#')).toBe('my-persona')
    expect(sanitizePersonaId('  ')).toBe('persona')
    expect(sanitizePersonaId('active')).toBe('persona')
  })

  test('Given 超长 ID When 规范化 Then 截断到 64 字符', () => {
    expect(sanitizePersonaId('a'.repeat(100)).length).toBe(64)
  })

  test('Given 空轮与超量轮 When 归一化示范轮 Then 去空并截断上限', () => {
    const turns = Array.from({ length: MAX_PRIMER_TURNS + 4 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i === 0 ? '   ' : `轮 ${i}`,
    }))
    const normalized = normalizePrimerTurns(turns)
    expect(normalized?.length).toBe(MAX_PRIMER_TURNS)
    expect(normalized?.[0]?.content).toBe('轮 1')
    expect(normalizePrimerTurns([])).toBeUndefined()
    expect(normalizePrimerTurns(undefined)).toBeUndefined()
  })
})

describe('人设配置归一化', () => {
  test('Given 空配置 When 归一化 Then 内置人设齐全且默认为默认助手', () => {
    const config = normalizePersonaConfig(undefined)
    expect(config.personas.length).toBe(BUILTIN_PERSONAS.length)
    expect(config.defaultPersonaId).toBe(BUILTIN_DEFAULT_PERSONA_ID)
  })

  test('Given 用户人设与失效默认 When 归一化 Then 保留用户人设并回退默认', () => {
    const config = normalizePersonaConfig({
      personas: [makePersona()],
      defaultPersonaId: 'not-exists',
    })
    expect(config.personas.some((p) => p.id === 'custom-1')).toBe(true)
    expect(config.defaultPersonaId).toBe(BUILTIN_DEFAULT_PERSONA_ID)
  })

  test('Given 默认助手种子 When 检查 Then 正文为空且描述指向问答基线', () => {
    const builtin = BUILTIN_PERSONAS.find((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID)
    expect(builtin?.body).toBe('')
    expect(builtin?.primerTurns).toBeUndefined()
    expect(builtin?.description).toContain('侧栏问答使用内置基线')
  })

  test('Given 文件中残留旧内置内容 When 归一化 Then 内置内容始终与源码同步', () => {
    const staleBuiltin = { ...BUILTIN_PERSONAS[0]!, body: '旧版基线正文' }
    const config = normalizePersonaConfig({ personas: [staleBuiltin] })
    const builtin = config.personas.find((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID)
    expect(builtin?.body).toBe(BUILTIN_PERSONAS[0]!.body)
    expect(config.personas.filter((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID).length).toBe(1)
  })

  test('Given raw 中持久化的旧内置正文 When 归一化 Then 丢弃旧正文，默认助手正文为空', () => {
    const config = normalizePersonaConfig({
      personas: [
        {
          id: BUILTIN_DEFAULT_PERSONA_ID,
          name: 'Proma 默认助手',
          description: '旧描述',
          body: '你首先是某个大模型，这我们当然知道……',
          builtin: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    const builtin = config.personas.find((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID)
    expect(builtin?.body).toBe('')
    expect(config.personas.filter((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID).length).toBe(1)
  })

  test('Given 会话显式人设 When 解析 Then 显式优先于默认', () => {
    const config = normalizePersonaConfig({ personas: [makePersona()], defaultPersonaId: 'custom-1' })
    expect(resolveSessionPersona(config)?.id).toBe('custom-1')
    expect(resolveSessionPersona(config, BUILTIN_DEFAULT_PERSONA_ID)?.id).toBe(BUILTIN_DEFAULT_PERSONA_ID)
    expect(resolveSessionPersona(config, 'missing')?.id).toBeUndefined()
  })
})

describe('Agent 人设注入段', () => {
  test('Given 默认助手 When 构建注入段 Then 不注入（产品提示词已覆盖）', () => {
    const config = normalizePersonaConfig(undefined)
    expect(buildPersonaPromptSection(resolveSessionPersona(config))).toBeUndefined()
  })

  test('Given 自定义人设 When 构建注入段 Then 包含名称正文与契约优先声明', () => {
    const section = buildPersonaPromptSection(makePersona({ name: '工程核', body: '证据优先。' }))
    expect(section).toContain('## 人设：工程核')
    expect(section).toContain('证据优先。')
    expect(section).toContain('安全契约')
  })

  test('Given 空正文人设 When 构建注入段 Then 不注入', () => {
    expect(buildPersonaPromptSection(makePersona({ body: '   ' }))).toBeUndefined()
    expect(buildPersonaPromptSection(undefined)).toBeUndefined()
  })
})

describe('问答 systemMessage 构建', () => {
  test('Given 人设不存在 When 构建 Then 返回 undefined', () => {
    expect(buildQaSystemMessage(undefined)).toBeUndefined()
  })

  test('Given 默认助手 When 构建 Then 返回内置基线', () => {
    const config = normalizePersonaConfig(undefined)
    const builtin = config.personas.find((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID)
    expect(buildQaSystemMessage(builtin)).toBe(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given append 人设 When 构建 Then 基线后接人设段（含名称正文与契约优先）', () => {
    const message = buildQaSystemMessage(makePersona({ name: '工程核', body: '证据优先。', qaInjection: 'append' }))
    expect(message?.startsWith(QA_BASELINE_SYSTEM_PROMPT)).toBe(true)
    expect(message).toContain('## 人设：工程核')
    expect(message).toContain('证据优先。')
    expect(message).toContain('安全契约')
    expect(message).toBe(`${QA_BASELINE_SYSTEM_PROMPT}\n\n${buildPersonaPromptSection(makePersona({ name: '工程核', body: '证据优先。', qaInjection: 'append' }))}`)
  })

  test('Given replace 人设 When 构建 Then 仅用正文（不拼接基线）', () => {
    const message = buildQaSystemMessage(makePersona({ body: '  完整自定义提示词。  ', qaInjection: 'replace' }))
    expect(message).toBe('完整自定义提示词。')
    expect(message).not.toContain(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given 空正文 append 人设 When 构建 Then 回落内置基线', () => {
    expect(buildQaSystemMessage(makePersona({ body: '   ', qaInjection: 'append' }))).toBe(QA_BASELINE_SYSTEM_PROMPT)
  })

  test('Given 空正文 replace 人设 When 构建 Then 返回 undefined', () => {
    expect(buildQaSystemMessage(makePersona({ body: '   ', qaInjection: 'replace' }))).toBeUndefined()
  })
})

describe('问答注入模式归一化', () => {
  test('Given 缺失注入模式 When 归一化人设配置 Then 用户人设与内置种子都为 append', () => {
    const config = normalizePersonaConfig({ personas: [makePersona()] })
    expect(config.personas.find((p) => p.id === 'custom-1')?.qaInjection).toBe('append')
    expect(config.personas.find((p) => p.id === BUILTIN_DEFAULT_PERSONA_ID)?.qaInjection).toBe('append')
    expect(config.personas.find((p) => p.id === 'builtin-engineer')?.qaInjection).toBe('append')
  })

  test('Given 非法注入模式 When 归一化 Then 回退 append', () => {
    expect(normalizeQaInjection('bogus')).toBe('append')
    expect(normalizeQaInjection(undefined)).toBe('append')
    expect(normalizeQaInjection(42)).toBe('append')
    expect(normalizeQaInjection(null)).toBe('append')
  })

  test('Given 显式 replace When 归一化 Then 保留 replace', () => {
    expect(normalizeQaInjection('replace')).toBe('replace')
    const config = normalizePersonaConfig({ personas: [makePersona({ qaInjection: 'replace' })] })
    expect(config.personas.find((p) => p.id === 'custom-1')?.qaInjection).toBe('replace')
  })

  test('Given 已迁移的存量人设缺字段 When 归一化 Then 回补 replace', () => {
    const config = normalizePersonaConfig({
      personas: [makePersona({ id: 'migrated-legacy' })],
      migratedFromSystemPrompts: true,
    })
    expect(config.personas.find((p) => p.id === 'migrated-legacy')?.qaInjection).toBe('replace')
  })

  test('Given 无迁移标记或非 migrated 前缀 When 归一化 Then 仍为 append（不误判为存量）', () => {
    const noFlag = normalizePersonaConfig({ personas: [makePersona({ id: 'migrated-legacy' })] })
    expect(noFlag.personas.find((p) => p.id === 'migrated-legacy')?.qaInjection).toBe('append')

    const normalId = normalizePersonaConfig({
      personas: [makePersona({ id: 'custom-migrated' })],
      migratedFromSystemPrompts: true,
    })
    expect(normalId.personas.find((p) => p.id === 'custom-migrated')?.qaInjection).toBe('append')
  })

  test('Given 迁移人设已有显式 append When 归一化 Then 尊重显式值', () => {
    const config = normalizePersonaConfig({
      personas: [makePersona({ id: 'migrated-legacy', qaInjection: 'append' })],
      migratedFromSystemPrompts: true,
    })
    expect(config.personas.find((p) => p.id === 'migrated-legacy')?.qaInjection).toBe('append')
  })
})

describe('人设 Markdown 导入导出', () => {
  test('Given 完整 Markdown When 解析 Then 提取 frontmatter 正文与示范轮', () => {
    const markdown = `---
id: my-persona
name: 我的人设
description: 简介
order: 5
---

正文第一段。

<!-- primer:user -->

示范问题

<!-- primer:assistant -->

示范回答
`
    const persona = parsePersonaMarkdown(markdown, 'fallback')
    expect(persona?.id).toBe('my-persona')
    expect(persona?.name).toBe('我的人设')
    expect(persona?.description).toBe('简介')
    expect(persona?.order).toBe(5)
    expect(persona?.body).toBe('正文第一段。')
    expect(persona?.primerTurns).toEqual([
      { role: 'user', content: '示范问题' },
      { role: 'assistant', content: '示范回答' },
    ])
  })

  test('Given 无 frontmatter 文档 When 解析 Then 用 fallback id 且正文完整', () => {
    const persona = parsePersonaMarkdown('只有正文', 'file-stem')
    expect(persona?.id).toBe('file-stem')
    expect(persona?.body).toBe('只有正文')
    expect(persona?.primerTurns).toBeUndefined()
  })

  test('Given 空文档 When 解析 Then 返回 null', () => {
    expect(parsePersonaMarkdown('   ', 'x')).toBeNull()
  })

  test('Given 人设 When 序列化再解析 Then 往返一致', () => {
    const original = makePersona({
      id: 'round-trip',
      name: '往返',
      description: '描述',
      order: 7,
      primerTurns: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: '答' },
      ],
    })
    const parsed = parsePersonaMarkdown(serializePersonaMarkdown(original), 'unused')
    expect(parsed?.id).toBe(original.id)
    expect(parsed?.name).toBe(original.name)
    expect(parsed?.description).toBe(original.description)
    expect(parsed?.order).toBe(original.order)
    expect(parsed?.body).toBe(original.body)
    expect(parsed?.primerTurns).toEqual(original.primerTurns)
  })
})