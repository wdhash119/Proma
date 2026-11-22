/**
 * P4：spine_recall（Live Compact 原文召回）的渲染标签。
 *
 * 该工具由 Pi extension 直接 registerTool 注册，不走 customTools 管线，
 * 因此渲染层必须自己补中文标签与图标，否则工具行会显示裸 `spine_recall`。
 */

import { describe, expect, test } from 'bun:test'
import { getToolPhrase } from './tool-phrase'
import { getToolDisplayName, getToolIcon } from './tool-utils'

describe('spine_recall 渲染标签', () => {
  test('Given 带卡片 ref When 生成短语 Then 显示中文原文召回而不是裸工具名', () => {
    const phrase = getToolPhrase('spine_recall', { ref: 'entry-42' })

    expect(phrase.label).toBe('原文召回 entry-42')
    expect(phrase.label).not.toContain('spine_recall')
    expect(phrase.loadingLabel).toBe('正在原文召回 entry-42...')
  })

  test('Given 缺少 ref When 生成短语 Then 仍回退到中文标签', () => {
    expect(getToolPhrase('spine_recall', {}).label).toBe('原文召回')
  })

  test('Given 工具名 When 查显示名与图标 Then 有中文名与专属图标', () => {
    expect(getToolDisplayName('spine_recall')).toBe('原文召回')
    // ArchiveRestore 来自 lucide-react，函数存在即可（与未映射时的 Wrench 兜底区分）。
    expect(getToolIcon('spine_recall')).not.toBe(getToolIcon('unknown_tool_placeholder'))
  })
})
