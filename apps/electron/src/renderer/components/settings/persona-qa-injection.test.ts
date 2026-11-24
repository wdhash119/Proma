import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'PersonaSettings.tsx'), 'utf8')

/**
 * Chat 退役后，人设编辑器不再提供「问答注入方式」选择器。
 * 保留该契约文件是为了防止问答专属 UI 与字段回流。
 */
describe('人设编辑器不再包含问答专属 UI', () => {
  test('Given 人设编辑器 When 检查 Then 不出现问答注入选择器与字段', () => {
    expect(source).not.toContain('editQaInjection')
    expect(source).not.toContain('updateQaInjection')
    expect(source).not.toContain('qaInjection')
    expect(source).not.toContain('问答注入')
    expect(source).not.toContain('PersonaQaInjection')
    expect(source).not.toContain('叠加在内置基线之上')
    expect(source).not.toContain('作为完整系统提示词')
  })
})
