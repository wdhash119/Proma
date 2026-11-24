import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agentDirectory = join(import.meta.dir, 'agent')

describe('Agent 工具栏独立额度徽标', () => {
  test('Given 当前选中模型所属渠道 When 渲染工具栏 Then 额度徽标紧跟上下文圆圈并跟随渠道', () => {
    const source = readFileSync(join(agentDirectory, 'AgentView.tsx'), 'utf8')
    const contextIndex = source.indexOf("key: 'context-usage'")
    const quotaIndex = source.indexOf("key: 'channel-plan-quota'")

    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(quotaIndex).toBeGreaterThan(contextIndex)
    expect(source).toContain("import { ChannelPlanQuotaBadge } from '@/components/models/ChannelPlanQuotaBadge'")
    expect(source).toContain('channel={stableChannel}')
    expect(source).toContain('variant="toolbar"')
  })

  test('Given 上下文圆圈浮窗 When 检查职责 Then 不再查询或展示渠道额度', () => {
    const source = readFileSync(join(agentDirectory, 'ContextUsageBadge.tsx'), 'utf8')

    expect(source).not.toContain('PlanQuota')
    expect(source).not.toContain('fetchChannelPlanQuota')
    expect(source).not.toContain('channelUpdatedAt')
    expect(source).not.toContain('订阅额度')
  })

  test('Given 独立额度徽标持续挂载 When 检查刷新机制 Then 定期刷新并复用统一查询缓存', () => {
    const source = readFileSync(join(import.meta.dir, 'models', 'ChannelPlanQuotaBadge.tsx'), 'utf8')

    expect(source).toContain('fetchChannelPlanQuota')
    expect(source).toContain('setInterval')
    expect(source).toContain('currentPlanQuota')
  })
})
