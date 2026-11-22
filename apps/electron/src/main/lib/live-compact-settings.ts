/**
 * Live Compact 的开关解析与查询侧组装（主进程唯一入口）。
 *
 * 数据流：
 *   settings.liveCompact.enabled（全局主闸）+ AgentSessionMeta.liveCompact（会话级单向关闭）
 *     → resolveLiveCompactEnabled（本文件，truth table 可测）
 *     → buildLiveCompactQueryInput（本文件，唯一一处 computeLiveCompactThresholds 求值）
 *     → PiAgentQueryOptions.liveCompact
 *         ├─ pi-utility-adapter fork env 注入（thresholds.env，即同一次求值的 env 记录）
 *         └─ utility 进程的 Pi extension factory（thresholds 的数值部分）
 *
 * 为什么阈值在**主进程**求值而不是 utility 进程：
 * 1. fork env 必须在子进程启动前确定，utility 进程自己算已经来不及；
 * 2. env 记录与胶层参数必须来自同一次求值（P2a 的 thresholds 单源契约），
 *    跨进程各算一次就必然出现两份来源。
 * 因此这里一次求值后整体随查询输入跨进程传递，utility 侧只消费、不再计算。
 */

import { DEFAULT_CONTEXT_WINDOW, inferContextWindow } from '@proma/shared'
import type { AgentSessionMeta, ModelCapabilityOverrides } from '@proma/shared'
import type { LiveCompactSettings } from '../../types'
import { computeLiveCompactThresholds, type LiveCompactThresholds } from './adapters/live-compact-thresholds'

/** 参与开关解析的最小元数据形状（便于 truth table 测试直接构造）。 */
export interface LiveCompactMetaCarrier {
  /**
   * 会话级开关：只在全局启用（主闸打开）时参与解析。
   * undefined = 继承全局（默认启用）；false = 本会话单独关闭；true = 与继承等价。
   */
  liveCompact?: boolean
}

/** 参与开关解析的最小设置形状。 */
export interface LiveCompactSettingsCarrier {
  liveCompact?: LiveCompactSettings
}

/**
 * 解析本轮生效的 Live Compact 开关。
 *
 * **全局开关是主闸（master gate），会话级只做单向关闭**：
 * - 全局未启用（false / 缺省 / 非布尔）→ 一律 false，无论会话 meta 写了什么；
 *   全局关闭必须硬停所有会话，否则用户关掉全局开关后仍有会话在静默改写上下文。
 * - 全局启用 + 会话未设置（undefined）→ true（继承 = 开）。
 * - 全局启用 + 会话 true → true。
 * - 全局启用 + 会话 false → false（会话单独关闭）。
 *
 * 即 effective = globalEnabled && (meta.liveCompact ?? true)，缺少任一条件都不生效。
 * 默认关闭（全局缺省 false）因此仍然保证“未启用时运行链路零变化”。
 */
export function resolveLiveCompactEnabled(
  meta: LiveCompactMetaCarrier | undefined | null,
  settings: LiveCompactSettingsCarrier | undefined | null,
): boolean {
  // 主闸：只有显式 true 才算全局启用，与设置读取侧的容错归一保持一致。
  if (settings?.liveCompact?.enabled !== true) return false
  // 主闸打开后，会话只能显式关闭；undefined 视为继承（开）。
  return meta?.liveCompact !== false
}

/** 跨进程随查询输入下发的 Live Compact 参数（必须是结构化可克隆的纯数据）。 */
export interface LiveCompactQueryInput {
  /** 已解析的生效开关；只有 true 时才会加入 extension factory。 */
  enabled: boolean
  /** 按模型窗口换算好的阈值（含 fork env 记录，见 live-compact-thresholds）。 */
  thresholds: LiveCompactThresholds
  /**
   * 覆盖层清单（`<configDir>/live-compact/active.json`）所在配置目录。
   * utility 进程自己去猜配置目录会踩 PROMA_DEV 与打包态的差异，
   * 所以由已知确切路径的主进程显式传入。
   */
  configDir: string
}

/**
 * 解析换算阈值用的模型上下文窗口。
 *
 * 来源优先级：
 * 1. 渠道模型能力的手动覆盖（用户按供应商文档修正过的窗口）；
 * 2. shared 的 inferContextWindow（已验证模型家族；未知模型回落 200K 默认值）。
 *
 * 为什么不在这里查 Pi 模型目录：目录查询只在 utility 进程构建模型时才拿到最终值，
 * 主进程另查一次会多一次目录加载且可能因订阅渠道的补丁路径而得到不同结果。
 * 用不到精确值时按 200K 保守估计——窗口估小只会让 spine 更早触发（仍高于 0.5 倍
 * 真实窗口的触发线），不会让上下文真的溢出，官方 0.8W 自动压缩继续兜底。
 */
export function resolveLiveCompactContextWindow(input: {
  modelId?: string
  modelCapabilities?: ModelCapabilityOverrides
}): number {
  const override = input.modelCapabilities?.contextWindow
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.round(override)
  }
  return inferContextWindow(input.modelId) ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * 组装本轮查询用的 Live Compact 参数；关闭或求值失败时返回 undefined。
 *
 * 返回 undefined 是"零行为变化"的唯一保证：查询输入不带字段、fork env 不注入、
 * extensionFactories 不加入第五个工厂。
 */
export function buildLiveCompactQueryInput(input: {
  meta: Pick<AgentSessionMeta, 'liveCompact'> | undefined | null
  settings: LiveCompactSettingsCarrier | undefined | null
  modelId?: string
  modelCapabilities?: ModelCapabilityOverrides
  configDir: string
}): LiveCompactQueryInput | undefined {
  if (!resolveLiveCompactEnabled(input.meta, input.settings)) return undefined

  const contextWindow = resolveLiveCompactContextWindow({
    modelId: input.modelId,
    modelCapabilities: input.modelCapabilities,
  })
  try {
    const thresholds = computeLiveCompactThresholds(contextWindow)
    return { enabled: true, thresholds, configDir: input.configDir }
  } catch (error) {
    // 阈值不变量失败（例如窗口估算异常）时宁可本轮不启用，也不要把错误 env 下发到子进程。
    console.warn('[Live Compact] 阈值求值失败，本轮不启用:', error)
    return undefined
  }
}
