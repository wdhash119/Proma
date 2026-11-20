/**
 * Dock 角标计数工具
 *
 * 只统计需要用户回来看一眼或处理的事项。
 * 权限模式与计划模式已下线，因此只剩「未查看完成会话」与「待回答提问」。
 */

export interface DockBadgeCountInput {
  /** 已完成但尚未查看的 Agent 会话数量 */
  unviewedCompletedCount: number
  /** 待回答 AskUser 请求数量 */
  pendingAskUserCount: number
}

/** 统计按会话分组的待处理请求数量 */
export function countPendingRequests<T>(requestsBySession: ReadonlyMap<string, readonly T[]>): number {
  let total = 0
  for (const requests of requestsBySession.values()) {
    total += requests.length
  }
  return total
}

/** 计算 Dock 角标应该展示的总数 */
export function calculateDockBadgeCount(input: DockBadgeCountInput): number {
  return Math.max(0, input.unviewedCompletedCount + input.pendingAskUserCount)
}
