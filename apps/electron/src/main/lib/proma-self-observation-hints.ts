/**
 * Proma 自操作的观测诊断文本。
 *
 * 纯函数，不依赖 electron：
 * - 等待条件不满足时，把当前可见文本压成一小段回给模型，让它知道屏幕上到底有什么，
 *   而不是只收到 `matched: false` 去盲猜；
 * - 点击被遮挡时，把挡在前面的控件名报出来，模型才知道自己点到了别的东西
 *   （例如想收侧栏，却点到了「切换思考强度」）。
 */

const MAX_SAMPLE_CHARS = 400

/** 折叠空白并截断，避免把整页文本塞回上下文。 */
export function summarizeVisibleText(text: string, limit = MAX_SAMPLE_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}…`
}

/** 等待超时的提示：告诉模型去哪看真实界面状态，而不是重复同一个等待。 */
export function describeWaitTimeout(kind: 'text' | 'selector', value: string, visibleText: string): string {
  const target = kind === 'text' ? `文本「${value}」` : `selector「${value}」`
  const sample = summarizeVisibleText(visibleText)
  const screen = sample ? `当前可见文本：${sample}。` : '当前页面没有可见文本。'
  return `等待${target}超时，未在界面上出现。${screen}请重新调用 PromaObserve 确认当前界面后再决定下一步，不要重复同一个等待。`
}

export interface ObstructionDetails {
  role: string
  name: string
}

/**
 * 点击落点与目标不匹配时的报错。
 * 明确说出挡在前面的控件，模型才能区分「点偏了」和「界面还没打开」。
 */
export function describeClickObstruction(obstruction: ObstructionDetails | null): string {
  const description = obstruction?.name
    ? `${obstruction.role}「${obstruction.name}」`
    : obstruction?.role
      ? obstruction.role
      : '其他界面元素'
  // 不额外加空格：中文里「被X遮挡」连写更自然，也便于断言。
  return `目标元素当前被${description}遮挡，点击未执行。请先关闭浮层或提示，再重新调用 PromaObserve。`
}
