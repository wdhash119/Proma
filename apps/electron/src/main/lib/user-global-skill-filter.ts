/**
 * 用户全局 Skill 运行时过滤（纯函数）
 *
 * 用户级 Skills 位于 ~/.AGENTS/skills，由用户自行维护，Proma 只读扫描。
 * 设置页的开关不移动磁盘目录，而是写入 AppSettings.disabledUserSkillSlugs；
 * 本模块把这些名单转换成对 Pi 资源加载结果的过滤，保持逻辑可单测。
 */

import { basename, isAbsolute, relative, resolve } from 'node:path'

/** 路径是否位于 root 内（含 root 自身）。 */
function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 判断某个已解析的 Skill 目录是否属于被全局禁用的用户级 Skill。
 *
 * 只匹配用户全局根目录下的直接子目录：工作区里同名 Skill 不受影响。
 *
 * @param baseDir 已解析（realpath）的 Skill 目录
 * @param userGlobalRoot 已解析的用户全局 Skills 根目录
 * @param disabledSlugs 全局禁用的 slug 集合
 */
export function isDisabledUserGlobalSkill(
  baseDir: string,
  userGlobalRoot: string,
  disabledSlugs: ReadonlySet<string>,
): boolean {
  if (disabledSlugs.size === 0) return false
  const root = resolve(userGlobalRoot)
  const dir = resolve(baseDir)
  if (!isPathWithinRoot(dir, root)) return false
  const slug = basename(dir)
  return Boolean(slug) && disabledSlugs.has(slug)
}
