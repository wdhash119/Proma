import { describe, expect, test } from 'bun:test'
import type { AgentDelegationPolicy } from '@proma/shared'
import type { DelegationChannelView } from './delegation-target'
import {
  DelegationTargetError,
  buildDelegationPolicySnapshot,
  isDelegationPolicyTargetAvailable,
  listAvailableAgentModelsAcrossChannels,
  resolveDelegationTarget,
  resolveDelegationTargetWithPolicy,
} from './delegation-target'
import { normalizeDelegationPolicy, resolveDelegationConcurrencyCap } from '@proma/shared'

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

describe('委派策略：inherit', () => {
  test('Given inherit When Agent 传了别的模型 Then 强制父渠道父模型并记下被忽略传参', () => {
    const snapshot = buildDelegationPolicySnapshot({ mode: 'inherit' }, channels)
    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      argsChannelId: 'kimi',
      argsModelId: 'k3.1-pro',
      snapshot,
    }, channels)

    expect(resolution.policyMode).toBe('inherit')
    expect(resolution.channelId).toBe('deepseek')
    expect(resolution.modelId).toBe('deepseek-flash')
    expect(resolution.crossChannel).toBe(false)
    expect(resolution.ignoredArgs).toEqual({ channelId: 'kimi', modelId: 'k3.1-pro' })
    expect(resolution.fallback).toBeUndefined()
  })

  test('Given inherit 且 Agent 未传参 When 解析 Then 不产生 ignoredArgs', () => {
    const snapshot = buildDelegationPolicySnapshot({ mode: 'inherit' }, channels)
    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      snapshot,
    }, channels)

    expect(resolution.policyMode).toBe('inherit')
    expect(resolution.ignoredArgs).toBeUndefined()
  })
})

describe('委派策略：specified 可用', () => {
  test('Given 策略模型可用 When Agent 传了别的模型 Then 强制策略模型并记下被忽略传参', () => {
    const snapshot = buildDelegationPolicySnapshot(
      { mode: 'specified', channelId: 'kimi', modelId: 'k3.1-pro' },
      channels,
    )
    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      argsChannelId: 'deepseek',
      argsModelId: 'deepseek-v4-pro',
      snapshot,
    }, channels)

    expect(resolution.policyMode).toBe('specified')
    expect(resolution.channelId).toBe('kimi')
    expect(resolution.modelId).toBe('k3.1-pro')
    expect(resolution.crossChannel).toBe(true)
    expect(resolution.ignoredArgs).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(resolution.fallback).toBeUndefined()
  })
})

describe('委派策略：specified 不可用回落默认模式', () => {
  const disabledChannelPolicy: AgentDelegationPolicy = { mode: 'specified', channelId: 'off', modelId: 'off-model' }
  const disabledModelPolicy: AgentDelegationPolicy = {
    mode: 'specified',
    channelId: 'deepseek',
    modelId: 'disabled-model',
  }
  const missingModelPolicy: AgentDelegationPolicy = { mode: 'specified', channelId: 'kimi', modelId: 'not-exist' }

  test('Given 渠道被禁用 When 解析 Then 回落默认并尊重 Agent 传参且返回 fallback', () => {
    const snapshot = buildDelegationPolicySnapshot(disabledChannelPolicy, channels)
    expect(snapshot.effectiveMode).toBe('default')

    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      argsChannelId: 'kimi',
      argsModelId: 'k3.1-pro',
      snapshot,
    }, channels)

    expect(resolution.policyMode).toBe('default')
    expect(resolution.channelId).toBe('kimi')
    expect(resolution.modelId).toBe('k3.1-pro')
    expect(resolution.fallback).toEqual({
      from: 'specified',
      reason: 'model-unavailable',
      channelId: 'off',
      modelId: 'off-model',
    })
  })

  test('Given 模型被禁用 When 无 Agent 传参 Then 继承父会话并返回 fallback', () => {
    const snapshot = buildDelegationPolicySnapshot(disabledModelPolicy, channels)
    expect(snapshot.effectiveMode).toBe('default')

    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      snapshot,
    }, channels)

    expect(resolution.policyMode).toBe('default')
    expect(resolution.channelId).toBe('deepseek')
    expect(resolution.modelId).toBe('deepseek-flash')
    expect(resolution.fallback?.channelId).toBe('deepseek')
    expect(resolution.fallback?.modelId).toBe('disabled-model')
  })

  test('Given 模型不存在 When 无 Agent 传参 Then 继承父会话并返回 fallback', () => {
    const snapshot = buildDelegationPolicySnapshot(missingModelPolicy, channels)
    expect(snapshot.effectiveMode).toBe('default')

    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      snapshot,
    }, channels)

    expect(resolution.modelId).toBe('deepseek-flash')
    expect(resolution.fallback?.reason).toBe('model-unavailable')
    expect(resolution.fallback?.modelId).toBe('not-exist')
  })

  test('Given 快照仍标记 specified 但目标此刻已不可用 Then 解析时重新校验并回落', () => {
    const stale = buildDelegationPolicySnapshot({ mode: 'specified', channelId: 'kimi', modelId: 'k3.1-pro' }, channels)
    expect(stale.effectiveMode).toBe('specified')

    // 运行中渠道被禁用，快照过期。
    const disabledLater = channels.map((channel) =>
      channel.id === 'kimi' ? { ...channel, enabled: false } : channel)
    const resolution = resolveDelegationTargetWithPolicy({
      parentChannelId: 'deepseek',
      parentModelId: 'deepseek-flash',
      snapshot: stale,
    }, disabledLater)

    expect(resolution.policyMode).toBe('default')
    expect(resolution.channelId).toBe('deepseek')
    expect(resolution.fallback?.channelId).toBe('kimi')
  })
})

describe('委派策略：快照构建', () => {
  test('Given 合法 specified When 构建 Then specified 且带渠道名', () => {
    const snapshot = buildDelegationPolicySnapshot(
      { mode: 'specified', channelId: 'kimi', modelId: 'k3.1-pro' },
      channels,
    )

    expect(snapshot.effectiveMode).toBe('specified')
    expect(snapshot.channelName).toBe('Kimi Coding Plan')
    expect(snapshot.policy?.modelId).toBe('k3.1-pro')
    expect(snapshot.fallback).toBeUndefined()
  })

  test('Given 不可用 specified When 构建 Then default 且带 fallback', () => {
    const snapshot = buildDelegationPolicySnapshot(
      { mode: 'specified', channelId: 'off', modelId: 'off-model' },
      channels,
    )

    expect(snapshot.effectiveMode).toBe('default')
    expect(snapshot.fallback).toEqual({
      from: 'specified',
      reason: 'model-unavailable',
      channelId: 'off',
      modelId: 'off-model',
    })
  })

  test('Given null / 垃圾值 / mode=default When 构建 Then default 且 policy undefined', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}, { mode: 'default' }, { mode: 'specified' }]) {
      const snapshot = buildDelegationPolicySnapshot(raw, channels)
      expect(snapshot.effectiveMode).toBe('default')
      expect(snapshot.policy).toBeUndefined()
      expect(snapshot.fallback).toBeUndefined()
    }
  })

  test('Given inherit When 构建 Then inherit 且不校验可用性', () => {
    const snapshot = buildDelegationPolicySnapshot({ mode: 'inherit' }, channels)

    expect(snapshot.effectiveMode).toBe('inherit')
    expect(snapshot.fallback).toBeUndefined()
  })

  test('Given 非 specified 策略 When 检查可用性 Then 恒 true', () => {
    expect(isDelegationPolicyTargetAvailable({ mode: 'inherit' }, channels)).toBe(true)
    expect(isDelegationPolicyTargetAvailable({ mode: 'specified', channelId: 'off', modelId: 'off-model' }, channels))
      .toBe(false)
  })
})

describe('normalizeDelegationPolicy', () => {
  test('Given maxConcurrent 越界 When 规范化 Then 钳制到 [1,50]', () => {
    expect(normalizeDelegationPolicy({ mode: 'inherit', maxConcurrent: 0 })?.maxConcurrent).toBe(1)
    expect(normalizeDelegationPolicy({ mode: 'inherit', maxConcurrent: 99 })?.maxConcurrent).toBe(50)
    expect(normalizeDelegationPolicy({ mode: 'inherit', maxConcurrent: 8 })?.maxConcurrent).toBe(8)
  })

  test('Given maxConcurrent 非有限数字 When 规范化 Then 丢弃', () => {
    expect(normalizeDelegationPolicy({ mode: 'inherit', maxConcurrent: Number.NaN })?.maxConcurrent).toBeUndefined()
    expect(normalizeDelegationPolicy({ mode: 'inherit', maxConcurrent: '8' })?.maxConcurrent).toBeUndefined()
  })

  test('Given 非七档 thinkingLevel When 规范化 Then 丢弃', () => {
    expect(normalizeDelegationPolicy({ mode: 'inherit', thinkingLevel: 'ultra' })?.thinkingLevel).toBeUndefined()
    expect(normalizeDelegationPolicy({ mode: 'inherit', thinkingLevel: 'xhigh' })?.thinkingLevel).toBe('xhigh')
  })

  test('Given specified 缺 modelId / channelId When 规范化 Then undefined', () => {
    expect(normalizeDelegationPolicy({ mode: 'specified', channelId: 'kimi' })).toBeUndefined()
    expect(normalizeDelegationPolicy({ mode: 'specified', modelId: 'k3.1-pro' })).toBeUndefined()
    expect(normalizeDelegationPolicy({ mode: 'specified', channelId: 'kimi', modelId: 'k3.1-pro' })?.mode)
      .toBe('specified')
  })

  test('Given 未知模式或非对象 When 规范化 Then undefined 且不抛错', () => {
    expect(normalizeDelegationPolicy({ mode: 'weird' })).toBeUndefined()
    expect(normalizeDelegationPolicy({ mode: 'default' })).toBeUndefined()
    expect(normalizeDelegationPolicy(null)).toBeUndefined()
    expect(normalizeDelegationPolicy('inherit')).toBeUndefined()
  })
})

describe('resolveDelegationConcurrencyCap', () => {
  test('Given 有值 When 解析 Then 取策略值', () => {
    expect(resolveDelegationConcurrencyCap({ mode: 'inherit', maxConcurrent: 6 }, 4)).toBe(6)
  })

  test('Given 越界 When 解析 Then 钳制', () => {
    expect(resolveDelegationConcurrencyCap({ mode: 'inherit', maxConcurrent: 0 }, 4)).toBe(1)
    expect(resolveDelegationConcurrencyCap({ mode: 'inherit', maxConcurrent: 999 }, 4)).toBe(50)
  })

  test('Given 无策略或无上限 When 解析 Then 返回 fallback', () => {
    expect(resolveDelegationConcurrencyCap(undefined, 4)).toBe(4)
    expect(resolveDelegationConcurrencyCap({ mode: 'inherit' }, 4)).toBe(4)
  })
})

describe('委派策略下的模型清单 note', () => {
  test('Given inherit 或 specified When 列出 Then note 提示已固定', () => {
    for (const mode of ['inherit', 'specified'] as const) {
      const list = listAvailableAgentModelsAcrossChannels('deepseek', 'deepseek-flash', channels, mode)
      expect(list.note).toContain('已由用户固定')
      expect(list.note).toContain('不要为委派选择其他模型')
    }
  })

  test('Given 不传或 default When 列出 Then note 与现状一致', () => {
    const base = listAvailableAgentModelsAcrossChannels('deepseek', 'deepseek-flash', channels)
    const explicitDefault = listAvailableAgentModelsAcrossChannels('deepseek', 'deepseek-flash', channels, 'default')
    expect(explicitDefault.note).toBe(base.note)
    expect(base.note).toContain('继承父会话')
  })
})
