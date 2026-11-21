import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settingsDirectory = import.meta.dir

/**
 * PersonaSettings 源码契约：问答注入方式选择器必须存在，且两种模式的文案齐全。
 * 选择器只在非「Proma 默认助手」人设的编辑区出现，并走既有防抖保存链路。
 */
describe('人设设置页：问答注入方式选择', () => {
  const source = readFileSync(join(settingsDirectory, 'PersonaSettings.tsx'), 'utf8')

  test('Given 编辑区 When 检查 Then 存在问答注入方式选择器', () => {
    expect(source).toContain('问答注入方式')
    expect(source).toContain('editQaInjection')
    expect(source).toContain('updateQaInjection')
  })

  test('Given 两种注入模式 When 检查文案 Then append 与 replace 标签及说明齐全', () => {
    expect(source).toContain('叠加在内置基线之上')
    expect(source).toContain('与 Agent 一致：基线保留，人设定义角色与风格。')
    expect(source).toContain('作为完整系统提示词')
    expect(source).toContain('替换内置基线；正文需自带完整角色与协作约束。')
  })

  test('Given 切换模式 When 检查保存链路 Then 复用防抖保存并提交 qaInjection', () => {
    expect(source).toContain('scheduleSave({ qaInjection: next })')
    expect(source).toContain("qaInjection: next")
  })

  test('Given 默认助手选中 When 检查渲染条件 Then 注入选择器隐藏', () => {
    // 选择器紧跟在 !isBaselinePersona 条件判断内（默认助手编辑区已是基线只读预览）
    expect(source).toMatch(/\{!isBaselinePersona && \(\s*<div>\s*<label[^>]*>问答注入方式<\/label>/)
  })
})
