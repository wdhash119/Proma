import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDisabledUserSkillSlugs } from '../../types'
import { isDisabledUserGlobalSkill } from './user-global-skill-filter'
import { mapUserGlobalSkills, USER_GLOBAL_SKILL_MANAGED_MESSAGE } from './user-global-skills'

const libRoot = import.meta.dir

/** 用临时目录构造全局 Skills fixture，绝不触碰真实 ~/.AGENTS。 */
function createFixture(skills: Array<{ slug: string; name: string; description?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-user-global-skills-'))
  for (const skill of skills) {
    const dir = join(root, skill.slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', `name: ${skill.name}`, ...(skill.description ? [`description: ${skill.description}`] : []), '---', '', '正文'].join('\n'),
      'utf8',
    )
  }
  return root
}

describe('用户全局 Skill 扫描与禁用映射', () => {
  test('Given 全局目录存在多个 Skill When 扫描 Then 标记 source 为 user-global 并解析元数据', () => {
    const root = createFixture([
      { slug: 'proma-coach', name: 'Proma Coach', description: '使用顾问' },
      { slug: 'find-skills', name: 'Find Skills' },
    ])
    try {
      const skills = mapUserGlobalSkills(root, [])

      expect(skills.map((skill) => skill.slug).sort()).toEqual(['find-skills', 'proma-coach'])
      const coach = skills.find((skill) => skill.slug === 'proma-coach')
      expect(coach?.source).toBe('user-global')
      expect(coach?.name).toBe('Proma Coach')
      expect(coach?.description).toBe('使用顾问')
      expect(coach?.enabled).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 禁用名单包含某个 slug When 扫描 Then 只有该 Skill enabled=false', () => {
    const root = createFixture([
      { slug: 'proma-coach', name: 'Proma Coach' },
      { slug: 'find-skills', name: 'Find Skills' },
    ])
    try {
      const skills = mapUserGlobalSkills(root, ['find-skills'])

      expect(skills.find((skill) => skill.slug === 'find-skills')?.enabled).toBe(false)
      expect(skills.find((skill) => skill.slug === 'proma-coach')?.enabled).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 全局目录不存在 When 扫描 Then 返回空列表而不是抛错', () => {
    const missing = join(tmpdir(), `proma-missing-global-skills-${Date.now()}`)

    expect(mapUserGlobalSkills(missing, [])).toEqual([])
  })
})

describe('运行时禁用过滤（纯函数）', () => {
  test('Given 目录位于全局根下且 slug 在名单中 When 过滤 Then 命中', () => {
    expect(isDisabledUserGlobalSkill('/home/u/.AGENTS/skills/proma-coach', '/home/u/.AGENTS/skills', new Set(['proma-coach']))).toBe(true)
  })

  test('Given 同名 Skill 位于工作区目录 When 过滤 Then 不受全局名单影响', () => {
    expect(isDisabledUserGlobalSkill('/home/u/.proma/workspaces/w/skills/proma-coach', '/home/u/.AGENTS/skills', new Set(['proma-coach']))).toBe(false)
  })

  test('Given 全局目录下未禁用的 Skill When 过滤 Then 保留', () => {
    expect(isDisabledUserGlobalSkill('/home/u/.AGENTS/skills/find-skills', '/home/u/.AGENTS/skills', new Set(['proma-coach']))).toBe(false)
  })

  test('Given 空禁用名单 When 过滤 Then 一律保留，避免无谓路径比较', () => {
    expect(isDisabledUserGlobalSkill('/home/u/.AGENTS/skills/proma-coach', '/home/u/.AGENTS/skills', new Set())).toBe(false)
  })
})

describe('全局禁用名单设置默认值与 IPC 契约', () => {
  test('Given 旧配置没有该字段 When 归一化 Then 默认空名单并去重修剪', () => {
    expect(normalizeDisabledUserSkillSlugs(undefined)).toEqual([])
    expect(normalizeDisabledUserSkillSlugs('broken')).toEqual([])
    expect(normalizeDisabledUserSkillSlugs([' a ', 'a', '', 42])).toEqual(['a'])
  })

  test('Given 设置服务读取旧配置 When 解析 Then 同步补空名单', () => {
    const source = readFileSync(join(libRoot, 'settings-service.ts'), 'utf8')

    expect(source).toContain('normalizeDisabledUserSkillSlugs')
    expect(source).toContain('disabledUserSkillSlugs: []')
  })

  test('Given Skill 列表 IPC When 合并数据源 Then 工作区优先并追加用户全局 Skills', () => {
    const source = readFileSync(join(libRoot, '../ipc.ts'), 'utf8')

    expect(source).toContain('const workspaceSkills = getAllWorkspaceSkills(workspaceSlug)')
    expect(source).toContain('const userGlobalSkills = getUserGlobalSkills()')
    expect(source).toContain('return [...workspaceSkills, ...userGlobalSkills]')
  })

  test('Given 切换开关 IPC When Skill 来自全局目录 Then 只改禁用名单，不移动用户目录', () => {
    const source = readFileSync(join(libRoot, '../ipc.ts'), 'utf8')

    expect(source).toContain('isUserGlobalSkillSlug(skillSlug)')
    expect(source).toContain('setUserGlobalSkillEnabled(skillSlug, enabled)')
    expect(source).toContain('return toggleWorkspaceSkill(workspaceSlug, skillSlug, enabled)')
  })

  test('Given 破坏性操作 When 目标是全局 Skill Then 统一拒绝并指向用户目录', () => {
    const ipcSource = readFileSync(join(libRoot, '../ipc.ts'), 'utf8')
    const managerSource = readFileSync(join(libRoot, 'user-global-skills.ts'), 'utf8')

    expect(managerSource).toContain(USER_GLOBAL_SKILL_MANAGED_MESSAGE)
    for (const channel of [
      'AGENT_IPC_CHANNELS.DELETE_SKILL',
      'AGENT_IPC_CHANNELS.UPDATE_SKILL_FROM_SOURCE',
      'AGENT_IPC_CHANNELS.WRITE_SKILL_CONTENT',
      'AGENT_IPC_CHANNELS.WRITE_SKILL_FILE',
      'AGENT_IPC_CHANNELS.CREATE_SKILL_ENTRY',
      'AGENT_IPC_CHANNELS.DELETE_SKILL_ENTRY',
      'AGENT_IPC_CHANNELS.RENAME_SKILL_ENTRY',
      'AGENT_IPC_CHANNELS.OPEN_SKILL_FOLDER',
    ]) {
      expect(ipcSource).toContain(channel)
    }
    expect(ipcSource.match(/assertNotUserGlobalSkill\(skillSlug\)/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
  })

  test('Given 运行时装配 When 传入禁用名单 Then 资源加载器过滤用户全局 Skill', () => {
    const adapterSource = readFileSync(join(libRoot, 'adapters/pi-agent-adapter.ts'), 'utf8')
    const orchestratorSource = readFileSync(join(libRoot, 'agent-orchestrator.ts'), 'utf8')

    expect(adapterSource).toContain('disabledUserSkillSlugs?: string[]')
    expect(adapterSource).toContain('isDisabledUserGlobalSkill')
    expect(adapterSource).toContain('createPromaSkillsOverride(input.additionalSkillPaths, input.disabledUserSkillSlugs)')
    expect(orchestratorSource).toContain('disabledUserSkillSlugs: appSettings.disabledUserSkillSlugs ?? []')
  })
})
