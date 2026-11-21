/**
 * 异步会话动作的过期守卫。
 *
 * 预览面板的「重试 / 打开窗口」可能在慢请求期间被用户切换会话；返回时若仍
 * 无条件回填状态，会把旧会话的画面或错误挂到新会话下。这里统一判断会话是否
 * 仍是发起请求时的那个。
 */

/** 只有当前会话仍是请求发起时的会话，才执行回填。 */
export function applyIfSessionCurrent<T>(
  requestedSessionId: string,
  currentSessionId: () => string | null,
  apply: () => T,
): T | undefined {
  if (currentSessionId() !== requestedSessionId) return undefined
  return apply()
}
