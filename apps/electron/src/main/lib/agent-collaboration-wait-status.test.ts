import { describe, expect, test } from 'bun:test'
import { hasAbnormalDelegation, normalizeDelegationStatus } from './agent-collaboration-utils'

describe('等待目标的异常结束判定', () => {
  test('Given 全部子会话已完成 When 判定 Then 不视为异常', () => {
    expect(hasAbnormalDelegation([{ status: 'completed' }, { status: 'completed' }])).toBe(false)
  })

  test('Given 仍有子会话运行 When 等待超时 Then 不视为异常', () => {
    expect(hasAbnormalDelegation([{ status: 'running' }, { status: 'completed' }])).toBe(false)
  })

  test('Given 存在 failed 子会话 When 判定 Then 视为异常', () => {
    expect(hasAbnormalDelegation([{ status: 'completed' }, { status: 'failed' }])).toBe(true)
  })

  test('Given 存在 cancelled 或 interrupted 子会话 When 判定 Then 视为异常', () => {
    expect(hasAbnormalDelegation([{ status: 'cancelled' }])).toBe(true)
    expect(hasAbnormalDelegation([{ status: 'interrupted' }])).toBe(true)
  })

  test('Given 空等待目标 When 判定 Then 不视为异常', () => {
    expect(hasAbnormalDelegation([])).toBe(false)
  })

  test('Given 持久化摘要中的未知状态 When 规范化 Then 返回 undefined 且不参与异常判定', () => {
    expect(normalizeDelegationStatus('failed')).toBe('failed')
    expect(normalizeDelegationStatus(undefined)).toBeUndefined()
    expect(normalizeDelegationStatus('unknown-status')).toBeUndefined()
  })
})
