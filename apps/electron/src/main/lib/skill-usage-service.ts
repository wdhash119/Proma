/**
 * Skill 使用记录服务。
 *
 * 只记录「最后一次被使用的时间」与次数，用于在能力页标出长期未使用的 Skill。
 * 数据落在工作区目录下的 `skill-usage.json`，属于可移植 JSON 配置，不使用数据库。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

const SKILL_USAGE_FILE = 'skill-usage.json'
/** 超过该天数未使用即视为「长期未用」。 */
export const SKILL_UNUSED_DAYS = 30

export interface SkillUsageEntry {
  lastUsedAt: number
  useCount: number
}

export interface SkillUsageSnapshot {
  version: 1
  skills: Record<string, SkillUsageEntry>
}

/** 仅供测试：注入隔离的工作区根目录，避免测试写入真实工作区。 */
let usageRootOverride: ((workspaceSlug: string) => string) | undefined

export function setSkillUsageRootForTesting(resolve: ((workspaceSlug: string) => string) | undefined): void {
  usageRootOverride = resolve
}

function usageFilePath(workspaceSlug: string): string {
  const dir = usageRootOverride
    ? usageRootOverride(workspaceSlug)
    : getAgentWorkspacePath(workspaceSlug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, SKILL_USAGE_FILE)
}

function readSnapshot(workspaceSlug: string): SkillUsageSnapshot {
  const filePath = usageFilePath(workspaceSlug)
  if (!existsSync(filePath)) return { version: 1, skills: {} }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<SkillUsageSnapshot>
    const skills: Record<string, SkillUsageEntry> = {}
    if (parsed && typeof parsed.skills === 'object' && parsed.skills !== null) {
      for (const [slug, entry] of Object.entries(parsed.skills)) {
        if (!entry || typeof entry !== 'object') continue
        const record = entry as Partial<SkillUsageEntry>
        if (typeof record.lastUsedAt !== 'number' || !Number.isFinite(record.lastUsedAt)) continue
        skills[slug] = {
          lastUsedAt: record.lastUsedAt,
          useCount: typeof record.useCount === 'number' ? record.useCount : 1,
        }
      }
    }
    return { version: 1, skills }
  } catch (error) {
    console.warn('[Skill 使用记录] 读取失败，按空记录继续:', error)
    return { version: 1, skills: {} }
  }
}

/** 读取某个工作区的 Skill 使用记录。 */
export function getSkillUsage(workspaceSlug: string): Record<string, SkillUsageEntry> {
  return readSnapshot(workspaceSlug).skills
}

/**
 * 记录一次 Skill 使用。同一轮内的多个 Skill 一次写入，避免每条激活都落盘；
 * 未知或空 slug 直接忽略，不因为脏数据影响主流程。
 */
export function recordSkillUsage(workspaceSlug: string, slugs: string[], now = Date.now()): void {
  const uniqueSlugs = [...new Set(slugs.filter((slug) => typeof slug === 'string' && slug.trim()))]
  if (uniqueSlugs.length === 0) return

  const snapshot = readSnapshot(workspaceSlug)
  for (const slug of uniqueSlugs) {
    const existing = snapshot.skills[slug]
    snapshot.skills[slug] = {
      lastUsedAt: now,
      useCount: (existing?.useCount ?? 0) + 1,
    }
  }

  try {
    writeJsonFileAtomic(usageFilePath(workspaceSlug), snapshot)
  } catch (error) {
    console.warn('[Skill 使用记录] 写入失败:', error)
  }
}

export interface SkillUsageLike {
  slug: string
}

/**
 * 计算长期未使用的 Skill slug 集合。
 *
 * 从未使用过的 Skill 也算未使用——这正是这个视图要暴露的情况；
 * 判定以「最后使用时间早于阈值」为准，不按安装时间推断。
 */
export function getUnusedSkillSlugs(
  skills: SkillUsageLike[],
  usage: Record<string, SkillUsageEntry>,
  now = Date.now(),
  days = SKILL_UNUSED_DAYS,
): string[] {
  const threshold = now - days * 24 * 60 * 60 * 1000
  return skills
    .filter((skill) => {
      const lastUsedAt = usage[skill.slug]?.lastUsedAt
      return lastUsedAt === undefined || lastUsedAt < threshold
    })
    .map((skill) => skill.slug)
}
