/**
 * Cua Driver 版本输出解析。
 *
 * 安装检测与 CDN 更新检查必须使用同一份解析规则：安装页把输出判为「已安装」，
 * 更新检查却判为「版本异常」会让用户在不存在的两条状态之间来回跳。
 */

import { valid } from 'semver'

/** 版本输出上限，防止异常输出进入日志与 UI。 */
const OUTPUT_MAX_LENGTH = 120

/**
 * `cua-driver 0.3.1`，可选 `(build 9f2c)` 后缀与行尾空白。
 *
 * 版本号本身仍用 semver 校验，避免 `01.2.3` 这类两边解释不一致的输入。
 */
const DRIVER_VERSION_LINE = /^cua-driver\s+(\S+)(?:\s+\(build\s+[0-9a-z._-]+\))?\s*$/i

/** 从 `cua-driver --version` 输出中取出可比较的纯 SemVer；无法识别时返回 null。 */
export function parseCuaDriverVersion(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed || trimmed.length > OUTPUT_MAX_LENGTH) return null
  const match = DRIVER_VERSION_LINE.exec(trimmed)
  if (!match) return null
  const version = match[1] ?? ''
  return valid(version) ? version : null
}
