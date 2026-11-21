/**
 * 从 DOM 属性提炼「这个无名控件是什么」的识别线索。
 *
 * 可访问性树里有相当比例的图标按钮没有名称。Agent 只看到一串 `button` 时只能靠顺序猜，
 * 而猜错会真的改动用户配置（例如把思考强度从「高」点成「关闭」）。
 * 这里把 DOM 上最有辨识度的属性压成一句短线索，让模型能选对元素。
 *
 * 纯函数，不依赖 electron。
 */

/** 纯样式类前缀：对「这是什么控件」没有帮助。 */
const STYLE_CLASS_PREFIXES = [
  'flex', 'grid', 'inline', 'block', 'hidden', 'absolute', 'relative', 'fixed', 'sticky',
  'size-', 'h-', 'w-', 'min-', 'max-', 'p-', 'px-', 'py-', 'pt-', 'pb-', 'pl-', 'pr-',
  'm-', 'mx-', 'my-', 'mt-', 'mb-', 'ml-', 'mr-', 'gap-', 'space-', 'rounded', 'border',
  'bg-', 'text-', 'font-', 'leading-', 'tracking-', 'shadow', 'ring-', 'z-', 'top-', 'right-',
  'bottom-', 'left-', 'inset-', 'translate-', 'scale-', 'rotate-', 'opacity-', 'transition',
  'duration-', 'ease-', 'cursor-', 'select-', 'overflow-', 'items-', 'justify-', 'shrink',
  'grow', 'truncate', 'whitespace-', 'outline-', 'antialiased', 'titlebar-', 'group',
  'hover:', 'focus:', 'active:', 'disabled:', 'dark:', 'sm:', 'md:', 'lg:', 'xl:',
]

function isStyleClass(token: string): boolean {
  const lower = token.toLowerCase()
  return STYLE_CLASS_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix))
}

/** 把 CDP 的扁平属性数组转成对象；同名属性保留首个。 */
export function attributesToRecord(attributes: string[] | undefined): Record<string, string> {
  const record: Record<string, string> = {}
  if (!Array.isArray(attributes)) return record
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index]
    const value = attributes[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') continue
    if (name in record) continue
    record[name.toLowerCase()] = value
  }
  return record
}

/**
 * 提炼识别线索。优先级：
 * 显式标识（data-testid / aria-label / title / id）→ 语义类名 → input type。
 * 都没有时返回空串，调用方可以据此提示模型改用 selector。
 */
export function buildElementHint(attributes: Record<string, string>): string {
  for (const key of ['data-testid', 'data-test', 'aria-label', 'title', 'name', 'id']) {
    const value = attributes[key]?.trim()
    if (value) return value.slice(0, 60)
  }

  const className = attributes.class?.trim()
  if (className) {
    const meaningful = className
      .split(/\s+/)
      .filter((token) => token.length > 3 && !isStyleClass(token))
      .slice(0, 3)
    if (meaningful.length > 0) return meaningful.join(' ').slice(0, 60)
  }

  const type = attributes.type?.trim()
  if (type) return `type=${type}`

  return ''
}

/** 无名元素的提示语：告诉模型别猜，改用 selector 精确定位。 */
export function describeUnnamedElement(role: string): string {
  return `无名 ${role}：用 PromaDomAction 按 selector 精确操作，或按 hint 选择，不要凭顺序猜。`
}
