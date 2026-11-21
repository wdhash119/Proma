import { describe, expect, test } from 'bun:test'
import { DEFAULT_SETTINGS_TAB, normalizeSettingsTab } from './settings-tab'

describe('设置标签页运行时回退', () => {
  test('Given 已移除的历史 Chat 标签页 When 校验 Then 回退默认标签页', () => {
    expect(normalizeSettingsTab('chat-history')).toBe(DEFAULT_SETTINGS_TAB)
  })

  test('Given 未知字符串或非字符串 When 校验 Then 回退默认标签页', () => {
    expect(normalizeSettingsTab('unknown-tab')).toBe(DEFAULT_SETTINGS_TAB)
    expect(normalizeSettingsTab(undefined)).toBe(DEFAULT_SETTINGS_TAB)
    expect(normalizeSettingsTab(42)).toBe(DEFAULT_SETTINGS_TAB)
  })

  test('Given 合法标签页 When 校验 Then 原样返回，不改变用户当前页', () => {
    expect(normalizeSettingsTab('personas')).toBe('personas')
    expect(normalizeSettingsTab('general')).toBe('general')
  })
})
