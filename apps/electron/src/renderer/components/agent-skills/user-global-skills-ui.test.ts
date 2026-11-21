import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillMeta } from '@proma/shared'
import { getSkillGroupTitle, groupSkills } from './skillGrouping'

const skillsDirectory = import.meta.dir

function createSkill(overrides: Partial<SkillMeta> & { slug: string }): SkillMeta {
  return { name: overrides.slug, enabled: true, ...overrides }
}

describe('全局 Skill 在 Skills 列表中的分组', () => {
  test('Given 无 group 的用户全局 Skill When 分组 Then 归入「用户全局」而非「未分组」', () => {
    const skill = createSkill({ slug: 'proma-coach', source: 'user-global' })

    expect(getSkillGroupTitle(skill)).toBe('用户全局')
    expect(groupSkills([skill])[0]?.title).toBe('用户全局')
  })

  test('Given 工作区 Skill 未声明 group When 分组 Then 仍归入「未分组」', () => {
    const skill = createSkill({ slug: 'local-skill' })

    expect(getSkillGroupTitle(skill)).toBe('未分组')
  })

  test('Given 全局 Skill 自带 group When 分组 Then 尊重显式分组', () => {
    const skill = createSkill({ slug: 'proma-coach', source: 'user-global', group: '协作' })

    expect(getSkillGroupTitle(skill)).toBe('协作')
  })
})

describe('全局 Skill 卡片与详情视图契约', () => {
  test('Given 全局 Skill When 渲染卡片 Then 显示「全局」徽章而不是「本项目」', () => {
    const source = readFileSync(join(skillsDirectory, 'SkillCard.tsx'), 'utf8')

    expect(source).toContain("skill.source === 'user-global'")
    expect(source).toContain('全局')
  })

  test('Given 全局 Skill 详情 When 检查 Then 隐藏删除/更新/打开目录并对编辑只读', () => {
    const source = readFileSync(join(skillsDirectory, 'SkillDetailView.tsx'), 'utf8')

    expect(source).toContain("const isUserGlobal = skill.source === 'user-global'")
    expect(source).toContain('if (isUserGlobal) return')
    expect(source).toContain('{!isUserGlobal && skill.hasUpdate && (')
    expect(source).toContain('{!isBuiltin && !isUserGlobal && (')
    expect(source).toContain('readOnly={isUserGlobal}')
    expect(source).toContain('~/.AGENTS/skills')
  })
})
