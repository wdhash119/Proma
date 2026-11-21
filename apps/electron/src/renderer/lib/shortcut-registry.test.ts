import { afterEach, describe, expect, test } from 'bun:test'
import { isShortcutDispatchedLocally, updateShortcutOverrides } from './shortcut-registry'

afterEach(() => {
  updateShortcutOverrides({})
})

describe('全局快捷键的应用内回退', () => {
  test('Given quick-capture 声明 localFallback When 重建缓存 Then 进入本地分发', () => {
    updateShortcutOverrides({})

    expect(isShortcutDispatchedLocally('quick-capture')).toBe(true)
  })

  test('Given 纯全局快捷键未声明回退 When 重建缓存 Then 不重复本地分发', () => {
    updateShortcutOverrides({})

    expect(isShortcutDispatchedLocally('quick-task')).toBe(false)
    expect(isShortcutDispatchedLocally('show-main-window')).toBe(false)
  })

  test('Given quick-capture 被用户禁用 When 重建缓存 Then 本地回退也移除', () => {
    updateShortcutOverrides({ 'quick-capture': { mac: null, win: null } })

    expect(isShortcutDispatchedLocally('quick-capture')).toBe(false)
  })
})
