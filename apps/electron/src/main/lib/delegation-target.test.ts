import { describe, expect, test } from 'bun:test'
import type { DelegationChannelView } from './delegation-target'
import {
  DelegationTargetError,
  listAvailableAgentModelsAcrossChannels,
  resolveDelegationTarget,
} from './delegation-target'

/** 两个供应商渠道 + 一个重复模型 + 一个禁用渠道。 */
const channels: DelegationChannelView[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    enabled: true,
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', enabled: true },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', enabled: true },
      { id: 'disabled-model', name: 'disabled-model', enabled: false },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi Coding Plan',
    provider: 'kimi-coding',
    enabled: true,
    models: [
      { id: 'k3.1-pro', name: 'K3.1 Pro', enabled: true },
    ],
  },
  {
    id: 'shared',
    name: '共享渠道',
    provider: 'openai',
    enabled: true,
    models: [
      { id: 'deepseek-flash', name: 'deepseek-flash', enabled: true },
    ],
  },
  {
    id: 'off',
    name: '已关闭渠道',
    provider: 'deepseek',
    enabled: false,
    models: [
      { id: 'off-model', name: 'off-model', enabled: true },
    ],
  },
]

const parentOf = (channelId: string, modelId?: string): { parentChannelId: string; parentModelId?: string } =>
  modelId === undefined ? { parentChannelId: channelId } : { parentChannelId: channelId, parentModelId: modelId }

describe('继承父会话', () => {
  test('Given 未指定任何目标 When 解析 Then 继承父渠道与模型', () => {
    const target = resolveDelegationTarget(parentOf('deepseek', 'deepseek-flash'), channels)

    expect(target.channelId).toBe('deepseek')
    expect(target.modelId).toBe('deepseek-flash')
    expect(target.crossChannel).toBe(false)
  })

  test('Given 父会话模型为空 When 解析 Then 沿用渠道默认', () => {
    const target = resolveDelegationTarget(parentOf('deepseek'), channels)

    expect(target.channelId).toBe('deepseek')
    expect(target.modelId).toBeUndefined()
  })
})

describe('跨渠道指定', () => {
  test('Given 显式渠道与模型 When 解析 Then 跨渠道且标记', () => {
    const target = resolveDelegationTarget(
      { ...parentOf('deepseek', 'deepseek-flash'), channelId: 'kimi', modelId: 'k3.1-pro' },
      channels,
    )

    expect(target.channelId).toBe('kimi')
    expect(target.provider).toBe('kimi-coding')
    expect(target.modelId).toBe('k3.1-pro')
    expect(target.crossChannel).toBe(true)
  })

  test('Given 只给渠道 When 解析 Then 取该渠道第一个启用模型', () => {
    const target = resolveDelegationTarget(
      { ...parentOf('deepseek', 'deepseek-flash'), channelId: 'kimi' },
      channels,
    )

    expect(target.channelId).toBe('kimi')
    expect(target.modelId).toBe('k3.1-pro')
  })

  test('Given 模型不属于指定渠道 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget(
      { ...parentOf('deepseek'), channelId: 'kimi', modelId: 'deepseek-v4-pro' },
      channels,
    )).toThrow('模型不属于指定渠道或未启用')
  })

  test('Given 渠道已关闭 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget(
      { ...parentOf('deepseek'), channelId: 'off' },
      channels,
    )).toThrow('不存在或未启用')
  })

  test('Given 渠道里模型全禁用 When 解析 Then 拒绝', () => {
    const onlyDisabled: DelegationChannelView[] = [
      ...channels,
      {
        id: 'empty',
        name: '无可用模型',
        provider: 'deepseek',
        enabled: true,
        models: [{ id: 'x', name: 'x', enabled: false }],
      },
    ]

    expect(() => resolveDelegationTarget({ ...parentOf('deepseek'), channelId: 'empty' }, onlyDisabled))
      .toThrow('没有启用的模型')
  })

  test('Given 禁用模型 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget(
      { ...parentOf('deepseek'), channelId: 'deepseek', modelId: 'disabled-model' },
      channels,
    )).toThrow('未启用')
  })
})

describe('只给模型的歧义处理', () => {
  test('Given 模型唯一归属 When 解析 Then 自动定位渠道', () => {
    const target = resolveDelegationTarget(
      { ...parentOf('deepseek', 'deepseek-flash'), modelId: 'k3.1-pro' },
      channels,
    )

    expect(target.channelId).toBe('kimi')
    expect(target.crossChannel).toBe(true)
  })

  test('Given 模型属于多个渠道 When 解析 Then 要求显式 channelId 并列出候选', () => {
    let message = ''
    try {
      resolveDelegationTarget({ ...parentOf('deepseek'), modelId: 'deepseek-flash' }, channels)
    } catch (error) {
      message = error instanceof DelegationTargetError ? error.message : String(error)
    }

    expect(message).toContain('属于多个启用渠道')
    expect(message).toContain('DeepSeek')
    expect(message).toContain('共享渠道')
  })

  test('Given 没有渠道提供该模型 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget({ ...parentOf('deepseek'), modelId: 'unknown' }, channels))
      .toThrow('没有启用渠道提供该模型')
  })

  test('Given 只在已关闭渠道里的模型 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget({ ...parentOf('deepseek'), modelId: 'off-model' }, channels))
      .toThrow('没有启用渠道提供该模型')
  })

  test('Given 父会话渠道不存在 When 解析 Then 拒绝', () => {
    expect(() => resolveDelegationTarget(parentOf('missing'), channels))
      .toThrow('父会话渠道不存在')
  })
})

describe('跨渠道模型清单', () => {
  test('Given 多个启用渠道 When 列出 Then 含全部渠道并标记当前', () => {
    const list = listAvailableAgentModelsAcrossChannels('deepseek', 'deepseek-flash', channels)

    expect(list.channels).toHaveLength(3)
    expect(list.channels.map((channel) => channel.channelId)).toEqual(['deepseek', 'kimi', 'shared'])
    const current = list.channels.flatMap((channel) => channel.models).filter((model) => model.current)
    // 只有「当前渠道 + 当前模型」同时匹配才标记，共享渠道里的同名模型不算。
    expect(current).toHaveLength(1)
    expect(list.currentModelAvailable).toBe(true)
    expect(list.note).toContain('继承父会话')
  })

  test('Given 没有启用渠道 When 列出 Then 给出配置提示', () => {
    const list = listAvailableAgentModelsAcrossChannels('x', undefined, [channels[3]!])

    expect(list.channels).toHaveLength(0)
    expect(list.modelCount).toBe(0)
    expect(list.note).toContain('没有任何启用渠道')
  })
})
