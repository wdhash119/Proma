import type { AgentSessionMeta } from '@proma/shared'

/** Diff 与 Vault 可同时发起首次创建；按父会话共享 Promise，避免产生孤立选区 Agent。 */
const pendingSelectionAgentCreates = new Map<string, Promise<AgentSessionMeta>>()

export function getOrCreateSelectionAgent(
  parentSessionId: string,
  create: () => Promise<AgentSessionMeta>,
): Promise<AgentSessionMeta> {
  const pending = pendingSelectionAgentCreates.get(parentSessionId)
  if (pending) return pending

  const created = create()
  pendingSelectionAgentCreates.set(parentSessionId, created)
  const clearPending = (): void => {
    // 让同 tick 的调用仍能共享已完成结果；调用方登记映射后下一轮才允许新创建。
    setTimeout(() => {
      if (pendingSelectionAgentCreates.get(parentSessionId) === created) {
        pendingSelectionAgentCreates.delete(parentSessionId)
      }
    }, 0)
  }
  void created.then(clearPending, clearPending)
  return created
}
