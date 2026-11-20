import { describe, expect, test } from 'bun:test'
import { shouldNotifyByPolicy } from './automation-notification-format'

describe('定时任务结果提醒策略', () => {
  test('Given 未设置策略 When 成功或失败 Then 都提醒（默认保持旧行为）', () => {
    expect(shouldNotifyByPolicy(undefined, 'success')).toBe(true)
    expect(shouldNotifyByPolicy(undefined, 'error')).toBe(true)
    expect(shouldNotifyByPolicy('always', 'success')).toBe(true)
  })

  test('Given 仅失败提醒 When 成功 Then 安静', () => {
    expect(shouldNotifyByPolicy('failures-only', 'success')).toBe(false)
    expect(shouldNotifyByPolicy('failures-only', 'error')).toBe(true)
  })

  test('Given 完全安静 When 成功或失败 Then 都不提醒', () => {
    expect(shouldNotifyByPolicy('never', 'success')).toBe(false)
    expect(shouldNotifyByPolicy('never', 'error')).toBe(false)
  })
})
