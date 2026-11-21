/**
 * CDP 可访问性（AX）节点读取的小工具。
 *
 * 浏览器与 Proma 自操作共用同一套判定：CDP 返回的 AX 值可能是字符串，
 * 也可能是 `{ type, value }` 结构，判断前必须先归一化，否则会把空名字当成有效名字。
 */

export interface CdpAxValue {
  type?: string
  value?: unknown
}

export interface CdpAxNode {
  backendDOMNodeId?: number
  role?: CdpAxValue | string
  name?: CdpAxValue | string
  value?: CdpAxValue | string
  properties?: Array<{ name?: string; value?: CdpAxValue | string }>
  ignored?: boolean
}

/** 从 CDP 的 AX 值里取字符串；两者都取不到时返回空串。 */
export function cdpTextValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as CdpAxValue
  if (typeof record.value === 'string') return record.value
  if (typeof record.value === 'number' || typeof record.value === 'boolean') return String(record.value)
  return ''
}

/** 读取布尔型 AX 属性（如 focused / editable）。 */
export function cdpAxPropertyBoolean(node: CdpAxNode, name: string): boolean {
  const properties = node.properties
  if (!Array.isArray(properties)) return false
  for (const property of properties) {
    if (property?.name !== name) continue
    const value = property.value
    if (value && typeof value === 'object' && (value as CdpAxValue).value === true) return true
    if (typeof value === 'string') return value === 'true'
  }
  return false
}

/**
 * 判断 AX 节点是否是可编辑字段：
 * 优先看 AX 的 editable 属性，其次看 role 是否属于输入类角色。
 */
export function isEditableCdpAxNode(node: CdpAxNode): boolean {
  if (cdpAxPropertyBoolean(node, 'editable')) return true
  const role = cdpTextValue(node.role).toLowerCase()
  return role === 'textbox' || role === 'searchbox' || role === 'combobox'
}
