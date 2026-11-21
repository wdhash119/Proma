/**
 * CDP 错误归一化。
 *
 * 用户在 Agent 操作期间动界面（关掉设置、切走标签、答完问题）会让 backendNodeId 失效，
 * CDP 直接抛 "No node with given id found" 这类内部错误名。模型看到这个既不知道
 * 发生了什么、也不知道该怎么办，容易原样重试。
 *
 * 这里把它翻译成可执行的指令：重新观察，并按用户当前界面继续。
 *
 * 纯函数，不依赖 electron。
 */

/** 元素引用失效时的可执行提示。 */
export const STALE_ELEMENT_MESSAGE
  = '该元素已随界面变化失效（可能因为界面被关闭、切换或重渲染）。请重新调用 PromaObserve 观察当前界面，再按现状继续，不要原样重试同一个 ref。'

/** 用户在场时界面可能被改动的提示：常用于 AskUserQuestion 之后。 */
export const INTERFACE_MAY_HAVE_CHANGED_MESSAGE
  = '等待用户期间界面可能已被改动。继续操作前先重新调用 PromaObserve。'

/** 判断是否为「节点已不存在」类 CDP 错误。 */
export function isStaleNodeError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase()
  if (!message) return false
  return message.includes('no node with given id')
    || message.includes('no node found')
    || message.includes('could not find node')
    || message.includes('node with given id does not belong')
    || message.includes('cannot find context with specified id')
    || message.includes('execution context was destroyed')
    // CDP 的措辞不统一：既有 "detached node"，也有 "Node is detached from document"。
    || message.includes('detached node')
    || message.includes('detached from document')
}

/** 判断是否为「文档树未请求」类错误（可自行修复，不该抛给模型）。 */
export function isDocumentNotRequestedError(error: unknown): boolean {
  return extractErrorMessage(error).toLowerCase().includes('document needs to be requested first')
}

/** 取出错误信息；兼容 Error、字符串与 CDP 的 { message } 结构。 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return ''
  const record = error as { message?: unknown; error?: unknown }
  if (typeof record.message === 'string') return record.message
  // Electron debugger 的失败形态是 { message, ... }，但个别版本把原因放在 error 字段。
  if (typeof record.error === 'string') return record.error
  return ''
}

/**
 * 归一化 CDP 错误：命中失效类错误时换成可执行提示，其余原样返回。
 * 保留原始 message 作为修复线索（写进日志，不进模型上下文）。
 */
export function normalizeCdpError(error: unknown): { message: string; stale: boolean; original: string } {
  const original = extractErrorMessage(error)
  if (isStaleNodeError(error)) {
    return { message: STALE_ELEMENT_MESSAGE, stale: true, original }
  }
  return { message: original || 'Proma 界面操作失败。', stale: false, original }
}
