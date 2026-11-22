/**
 * 用户全局 Skills（~/.AGENTS/skills）
 *
 * 这些 Skill 由用户自行维护、跨工作区生效；Proma 只读扫描并展示，
 * 开关只写入 AppSettings.disabledUserSkillSlugs（全局禁用名单），
 * 绝不移动、覆盖或删除用户目录内容。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillMeta } from '@proma/shared'
import { getUserAgentsSkillsDir } from './config-paths'
import { getSettings, updateSettings } from './settings-service'
import { scanSkillsInDir } from './agent-workspace-manager'

/** 用户全局 Skill 的破坏性操作统一拒绝文案。 */
export const USER_GLOBAL_SKILL_MANAGED_MESSAGE = '用户全局 Skill 请在 ~/.AGENTS/skills 目录管理'

/** 单段目录名判定：拒绝路径分隔符与相对路径片段，避免越过全局 Skills 根目录。 */
function isSinglePathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
}

/** 某个 slug 是否指向真实存在的用户全局 Skill。 */
export function isUserGlobalSkillSlug(skillSlug: string): boolean {
  if (!isSinglePathSegment(skillSlug)) return false
  return existsSync(join(getUserAgentsSkillsDir(), skillSlug))
}

/** 用户全局 Skill 的磁盘路径（仅用于只读展示与错误提示）。 */
function getUserGlobalSkillPath(skillSlug: string): string {
  return join(getUserAgentsSkillsDir(), skillSlug)
}

/**
 * 扫描指定目录并叠加禁用名单，标记 source='user-global'。
 *
 * 抽出目录参数是为了让测试使用临时 fixture，避免读写真实 ~/.AGENTS。
 */
export function mapUserGlobalSkills(dir: string, disabledSlugs: readonly string[]): SkillMeta[] {
  const disabled = new Set(disabledSlugs)
  return scanSkillsInDir(dir, true).map((skill) => ({
    ...skill,
    source: 'user-global' as const,
    enabled: !disabled.has(skill.slug),
  }))
}

/** 获取当前用户的全局 Skills（目录不存在时返回空列表）。 */
export function getUserGlobalSkills(): SkillMeta[] {
  const dir = getUserAgentsSkillsDir()
  if (!existsSync(dir)) return []
  return mapUserGlobalSkills(dir, getSettings().disabledUserSkillSlugs ?? [])
}

/** 切换用户全局 Skill 的全局启用状态：只改禁用名单，不碰用户目录。 */
export function setUserGlobalSkillEnabled(skillSlug: string, enabled: boolean): void {
  if (!isUserGlobalSkillSlug(skillSlug)) {
    throw new Error(`用户全局 Skill 不存在: ${skillSlug}`)
  }
  const disabled = new Set(getSettings().disabledUserSkillSlugs ?? [])
  if (enabled) disabled.delete(skillSlug)
  else disabled.add(skillSlug)
  updateSettings({ disabledUserSkillSlugs: [...disabled].sort() })
  console.log(`[Agent 工作区] 用户全局 Skill ${enabled ? '启用' : '禁用'}: ${skillSlug}`)
}

/**
 * 读取 SKILL.md 全文：优先工作区，其次用户全局目录。
 *
 * 只有只读回退：写入路径仍严格限定在工作区，用户目录永远不被 Proma 修改。
 */
export function readUserGlobalSkillContent(
  workspaceSlug: string,
  skillSlug: string,
  readWorkspaceContent: (workspaceSlug: string, skillSlug: string) => string,
): string {
  try {
    return readWorkspaceContent(workspaceSlug, skillSlug)
  } catch (error) {
    if (!isUserGlobalSkillSlug(skillSlug)) throw error
    const mdPath = join(getUserGlobalSkillPath(skillSlug), 'SKILL.md')
    if (!existsSync(mdPath)) throw error
    return readFileSync(mdPath, 'utf-8')
  }
}

/** 对用户全局 Skill 的写操作直接拒绝，并给出可执行的替代路径。 */
export function assertNotUserGlobalSkill(skillSlug: string): void {
  if (isUserGlobalSkillSlug(skillSlug)) {
    throw new Error(USER_GLOBAL_SKILL_MANAGED_MESSAGE)
  }
}
