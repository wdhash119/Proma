import { describe, expect, test } from 'bun:test'
import { applyIfSessionCurrent } from './session-request-guard'

describe('异步会话动作守卫', () => {
  test('Given 请求期间会话已切换 When 回填结果 Then 不执行且返回 undefined', () => {
    let applied = false
    const result = applyIfSessionCurrent('session-a', () => 'session-b', () => { applied = true })

    expect(applied).toBe(false)
    expect(result).toBeUndefined()
  })

  test('Given 会话未变 When 回填结果 Then 执行并返回结果', () => {
    const result = applyIfSessionCurrent('session-a', () => 'session-a', () => 'preview-a')

    expect(result).toBe('preview-a')
  })

  test('Given 当前会话为空 When 回填结果 Then 不执行', () => {
    let applied = false
    applyIfSessionCurrent('session-a', () => null, () => { applied = true })

    expect(applied).toBe(false)
  })
})
