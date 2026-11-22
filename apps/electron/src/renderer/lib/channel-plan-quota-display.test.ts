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
    const display = getPlanQuotaDisplay(result, 'deepseek', NOW)
    expect(display?.summary).toBe('¥78.82')
    // 无 message 时 tooltip 输出保持原样。
    expect(display?.title).toBe(`DeepSeek 账户余额\n账户余额: ¥78.82`)
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

describe('千问 Token Plan 个人版/团队版额度显示', () => {
  test('Given 个人版本月 84% When 格式化 Then 摘要显示月度窗口与重置时长', () => {
    const result = quota({
      provider: 'qianwen-token-plan',
      planName: '千问 Token Plan 个人版 Pro',
      windows: [quotaWindow({ label: '个人版本月', remainingPercent: 84, usedPercent: 16, resetAt: NOW + 3 * 86_400_000 })],
    })

    const display = getPlanQuotaDisplay(result, 'qianwen-token-plan', NOW)!
    expect(display.summary).toBe('个人版本月 84% · 3天')
    expect(display.title).toContain('千问 Token Plan 个人版 Pro')
    expect(display.title).toContain('个人版本月: 剩余 84%')
    expect(display.title).not.toContain('部分千问额度暂不可用')
    expect(display.muted).toBe(false)
  })

  test('Given 团队 Standard/Pro/Max 三个窗口 When 格式化 Then 摘要取前两个、tooltip 列出全部', () => {
    const result = quota({
      provider: 'qianwen-token-plan',
      planName: '千问 Token Plan 团队版',
      windows: [
        quotaWindow({ label: '团队 Standard', remainingPercent: 25, usedPercent: 75 }),
        quotaWindow({ label: '团队 Pro', remainingPercent: 50, usedPercent: 50 }),
        quotaWindow({ label: '团队 Max', remainingPercent: 100, usedPercent: 0 }),
      ],
    })

    const display = getPlanQuotaDisplay(result, 'qianwen-token-plan', NOW)!
    expect(display.summary).toBe('团队Standard 25% · 团队Pro 50%')
    expect(display.title).toContain('团队 Standard: 剩余 25%')
    expect(display.title).toContain('团队 Pro: 剩余 50%')
    expect(display.title).toContain('团队 Max: 剩余 100%')
  })

  test('Given 个人版与团队版同时存在 When 格式化 Then 摘要与 tooltip 同时覆盖两者', () => {
    const result = quota({
      provider: 'qianwen-token-plan-openai',
      planName: '千问 Token Plan（个人版 + 团队版）',
      windows: [
        quotaWindow({ label: '个人版本月', remainingPercent: 84, usedPercent: 16 }),
        quotaWindow({ label: '团队 Max', remainingPercent: 25, usedPercent: 75 }),
      ],
    })

    const display = getPlanQuotaDisplay(result, 'qianwen-token-plan-openai', NOW)!
    expect(display.summary).toBe('个人版本月 84% · 团队Max 25%')
    expect(display.title).toContain('千问 Token Plan（个人版 + 团队版）')
    expect(display.title).toContain('个人版本月: 剩余 84%')
    expect(display.title).toContain('团队 Max: 剩余 25%')
  })

  test('Given 部分成功带 message When 格式化 Then summary 不变且提示只追加到 tooltip 末尾', () => {
    const result = quota({
      provider: 'qianwen-token-plan',
      planName: '千问 Token Plan 个人版',
      windows: [quotaWindow({ label: '个人版本月', remainingPercent: 84, usedPercent: 16 })],
      message: '部分千问额度暂不可用',
    })

    const display = getPlanQuotaDisplay(result, 'qianwen-token-plan', NOW)!
    expect(display.summary).toBe('个人版本月 84%')
    expect(display.title.endsWith('部分千问额度暂不可用')).toBe(true)
    expect(display.muted).toBe(false)
  })

  test('Given 无重置时间 When 格式化 Then 不虚构重置时间', () => {
    const result = quota({
      provider: 'qianwen-token-plan',
      planName: '千问 Token Plan 个人版',
      windows: [quotaWindow({ label: '个人版本月', remainingPercent: 84, usedPercent: 16 })],
    })

    const display = getPlanQuotaDisplay(result, 'qianwen-token-plan', NOW)!
    expect(display.summary).toBe('个人版本月 84%')
    expect(display.title).not.toContain('重置')
  })

  test('Given 未登录或凭据过期 When 格式化 Then 显示主进程给出的原因', () => {
    for (const message of ['请先在编辑渠道中登录千问账号', '千问登录已过期，请重新登录']) {
      const display = getPlanQuotaDisplay(
        quota({ supported: false, provider: 'qianwen-token-plan-openai', message }),
        'qianwen-token-plan-openai',
      )
      expect(display).toMatchObject({ summary: '额度不可用', title: message, muted: true })
    }
  })

  test('Given Kimi Coding 5 小时与每周窗口 When 格式化 Then 保持既有 5H/周 展示', () => {
    const result = quota({
      provider: 'kimi-coding',
      planName: 'Kimi Coding Plan',
      windows: [
        quotaWindow({ type: '5h', label: '每 5 小时', remainingPercent: 80, usedPercent: 20, resetAt: NOW + 2 * 3_600_000 }),
        quotaWindow({ type: 'weekly', label: '每周额度', remainingPercent: 90, usedPercent: 10, resetAt: NOW + 6 * 86_400_000 }),
      ],
    })

    expect(getPlanQuotaDisplay(result, 'kimi-coding', NOW)?.summary).toBe('5H 80% · 2h · 周 90% · 6天')
  })
})
