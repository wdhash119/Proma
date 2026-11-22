import { describe, expect, test } from 'bun:test'
import type { ChannelPlanQuotaResult, ChannelPlanQuotaWindow } from '@proma/shared'
import { formatPlanQuotaResetDuration, getPlanQuotaDisplay } from './channel-plan-quota-display'

const NOW = Date.UTC(2026, 10, 22, 1, 0, 0)

function quotaWindow(patch: Partial<ChannelPlanQuotaWindow>): ChannelPlanQuotaWindow {
  return {
    type: 'custom',
    label: '额度',
    remainingPercent: 100,
    usedPercent: 0,
    ...patch,
  }
}

function quota(patch: Partial<ChannelPlanQuotaResult>): ChannelPlanQuotaResult {
  return {
    supported: true,
    provider: 'deepseek',
    windows: [],
    updatedAt: NOW,
    ...patch,
  }
}

describe('独立渠道额度徽标显示', () => {
  test('Given 任意付费渠道仍在加载 When 格式化 Then 显示加载状态而不是隐藏', () => {
    expect(getPlanQuotaDisplay(null, 'qwen')).toMatchObject({
      summary: '额度加载中',
      muted: true,
    })
  })

  test('Given 供应商无公开余额接口或查询失败 When 格式化 Then 显示不可用及真实原因', () => {
    const result = quota({
      supported: false,
      provider: 'openai',
      message: '当前渠道未提供可用的余额或订阅额度查询接口',
    })
    expect(getPlanQuotaDisplay(result, 'openai')).toMatchObject({
      summary: '额度不可用',
      title: '当前渠道未提供可用的余额或订阅额度查询接口',
      muted: true,
    })
  })

  test('Given Codex 5 小时与每周额度 When 格式化 Then 显示剩余比例与紧凑重置时间', () => {
    const result = quota({
      provider: 'openai-codex',
      planName: 'ChatGPT Pro (Codex)',
      windows: [
        quotaWindow({ type: '5h', label: '每 5 小时', remainingPercent: 86, usedPercent: 14, resetAt: NOW + 60 * 60 * 1000 }),
        quotaWindow({ type: 'weekly', label: '每周额度', remainingPercent: 93, usedPercent: 7, resetAt: NOW + 5 * 24 * 60 * 60 * 1000 }),
      ],
    })
    expect(getPlanQuotaDisplay(result, 'openai-codex', NOW)?.summary).toBe('5H 86% · 1h · 周 93% · 5天')
  })

  test('Given DeepSeek 金额余额 When 格式化 Then 只显示金额不附加窗口标签', () => {
    const result = quota({
      planName: 'DeepSeek 账户余额',
      windows: [quotaWindow({ label: '账户余额', remainingLabel: '¥78.82', showProgress: false })],
    })
    expect(getPlanQuotaDisplay(result, 'deepseek', NOW)?.summary).toBe('¥78.82')
  })

  test('Given 积分余额与重置天数 When 格式化 Then 显示积分和重置天数', () => {
    const result = quota({
      windows: [quotaWindow({ label: 'Token Plan', remainingLabel: '1 积分', showProgress: false, resetAt: NOW + 28 * 24 * 60 * 60 * 1000 })],
    })
    expect(getPlanQuotaDisplay(result, 'xiaomi-token-plan', NOW)?.summary).toBe('1 积分 · 28天')
  })
})

describe('额度重置时间紧凑格式', () => {
  test('Given 不同重置距离 When 格式化 Then 分钟、小时、天与过期状态清晰', () => {
    expect(formatPlanQuotaResetDuration(NOW + 30 * 60 * 1000, NOW)).toBe('30分钟')
    expect(formatPlanQuotaResetDuration(NOW + 60 * 60 * 1000, NOW)).toBe('1h')
    expect(formatPlanQuotaResetDuration(NOW + 5 * 24 * 60 * 60 * 1000, NOW)).toBe('5天')
    expect(formatPlanQuotaResetDuration(NOW - 1, NOW)).toBe('已到期')
    expect(formatPlanQuotaResetDuration(undefined, NOW)).toBeUndefined()
  })
})
