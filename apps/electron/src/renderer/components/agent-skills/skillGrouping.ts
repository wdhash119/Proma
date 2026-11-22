import type { SkillMeta } from '@proma/shared'

interface SkillGroup {
  id: string
  title: string
  skills: SkillMeta[]
}

const UNGROUPED_TITLE = '未分组'
/** 用户全局 Skills（~/.AGENTS/skills）没有分组时的兜底标题。 */
const USER_GLOBAL_TITLE = '用户全局'

function normalizeGroup(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

export function getSkillGroupTitle(skill: SkillMeta): string {
  if (skill.group) {
    const group = normalizeGroup(skill.group)
    if (group) return group
  }

  // 全局 Skill 与工作区 Skill 混在同一列表时，按来源给出可识别的兜底分组。
  if (skill.source === 'user-global') return USER_GLOBAL_TITLE

  return UNGROUPED_TITLE
}

export function groupSkills(skills: SkillMeta[]): SkillGroup[] {
  const groups = new Map<string, SkillMeta[]>()

  for (const skill of skills) {
    const title = getSkillGroupTitle(skill)
    const group = groups.get(title) ?? []
    group.push(skill)
    groups.set(title, group)
  }

  return [...groups.entries()]
    .map(([title, groupSkills]) => ({
      id: title.toLowerCase(),
      title,
      skills: groupSkills,
    }))
    .sort((a, b) => compareGroupTitle(a.title, b.title))
}

function compareGroupTitle(a: string, b: string): number {
  if (a === UNGROUPED_TITLE && b !== UNGROUPED_TITLE) return 1
  if (b === UNGROUPED_TITLE && a !== UNGROUPED_TITLE) return -1
  return a.localeCompare(b, 'zh-CN')
}
