/**
 * Live Compact 会话工具栏按钮的状态机（纯函数，便于单测）。
 *
 * 生效语义必须与主进程 `resolveLiveCompactEnabled` 完全一致：
 *   effective = globalEnabled && (meta.liveCompact ?? true)
 * 全局主闸只做硬停（按钮禁用），会话 meta 只能单向关闭本会话；
 * 点击一律写显式 true/false，不写 undefined——全局开启时 true 与继承等价，
 * 而显式值能让用户在下一次切换时看到确定的方向。
 */

/** 三种提示文案与状态一一对应，避免按钮与 tooltip 各写一份措辞。 */
export const LIVE_COMPACT_BUTTON_TOOLTIPS = {
  /** 会话生效中 */
  on: 'Live Compact 已开启（点击关闭）',
  /** 会话已关闭 */
  off: 'Live Compact 已关闭（点击开启）',
  /** 全局主闸未启用，点击无意义 */
  globalOff: '先在设置 → Live Compact 中启用全局开关',
} as const

export interface LiveCompactButtonInput {
  /** 全局主闸：settings.liveCompact.enabled */
  globalEnabled: boolean
  /** 会话 meta.liveCompact；undefined = 继承全局（默认启用） */
  sessionLiveCompact: boolean | undefined
  /** 正在提交：禁用点击，避免连点写出竞争状态 */
  pending?: boolean
}

export interface LiveCompactButtonState {
  /** 当前会话是否实际生效 */
  effective: boolean
  /** 按钮是否禁用（全局关闭或提交中） */
  disabled: boolean
  /** 点击后应写入会话 meta 的显式值 */
  nextSessionValue: boolean
  tooltip: string
  ariaLabel: string
}

/** 解析按钮的显示与点击语义。 */
export function resolveLiveCompactButtonState(
  input: LiveCompactButtonInput,
): LiveCompactButtonState {
  // 主闸关闭：无论会话 meta 是什么都不生效，按钮只做提示。
  if (!input.globalEnabled) {
    return {
      effective: false,
      disabled: true,
      nextSessionValue: false,
      tooltip: LIVE_COMPACT_BUTTON_TOOLTIPS.globalOff,
      ariaLabel: 'Live Compact（全局开关未启用）',
    }
  }

  const effective = input.sessionLiveCompact !== false
  return {
    effective,
    disabled: input.pending === true,
    nextSessionValue: !effective,
    tooltip: effective ? LIVE_COMPACT_BUTTON_TOOLTIPS.on : LIVE_COMPACT_BUTTON_TOOLTIPS.off,
    ariaLabel: effective ? '关闭 Live Compact' : '开启 Live Compact',
  }
}
