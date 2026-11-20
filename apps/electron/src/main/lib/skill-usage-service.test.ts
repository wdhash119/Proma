import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSkillUsage, getUnusedSkillSlugs, recordSkillUsage, setSkillUsageRootForTesting, SKILL_UNUSED_DAYS } from './skill-usage-service'

const workspaceSlug = 'usage-workspace'
const root = mkdtempSync(join(tmpdir(), 'proma-skill-usage-'))

function useTempRoot(): void {
  rmSync(join(root, workspaceSlug), { recursive: true, force: true })
  setSkillUsageRootForTesting((slug) => {
    const dir = join(root, slug)
    return dir
  })
}

describe('Skill 使用记录', () => {
  test('Given 首次使用 When 记录 Then 建立 lastUsedAt 与次数', () => {
    useTempRoot()
    const now = 1_700_000_000_000

    recordSkillUsage(workspaceSlug, ['proma-coach'], now)

    expect(getSkillUsage(workspaceSlug)).toEqual({
      'proma-coach': { lastUsedAt: now, useCount: 1 },
    })
    const raw = readFileSync(join(root, workspaceSlug, 'skill-usage.json'), 'utf8')
    expect(raw).toContain('proma-coach')
  })

  test('Given 重复使用 When 记录 Then 次数累加且时间更新', () => {
    useTempRoot()
    recordSkillUsage(workspaceSlug, ['proma-coach'], 1_700_000_000_000)
    recordSkillUsage(workspaceSlug, ['proma-coach'], 1_700_000_100_000)

    expect(getSkillUsage(workspaceSlug)['proma-coach']).toEqual({
      lastUsedAt: 1_700_000_100_000,
      useCount: 2,
    })
  })

  test('Given 同一轮多个 Skill When 记录 Then 一次写入全部生效', () => {
    useTempRoot()
    recordSkillUsage(workspaceSlug, ['a', 'b', 'a'], 1_700_000_000_000)

    const usage = getSkillUsage(workspaceSlug)
    expect(Object.keys(usage).sort()).toEqual(['a', 'b'])
    expect(usage.a?.useCount).toBe(1)
  })

  test('Given 空 slug When 记录 Then 忽略且不写文件', () => {
    useTempRoot()
    recordSkillUsage(workspaceSlug, ['', '  '], 1_700_000_000_000)

    expect(getSkillUsage(workspaceSlug)).toEqual({})
  })
})

describe('30 天未使用判定', () => {
  test('Given 从未使用 When 判定 Then 视为未使用', () => {
    const now = Date.UTC(2026, 10, 21)
    expect(getUnusedSkillSlugs([{ slug: 'fresh' }], {}, now)).toEqual(['fresh'])
  })

  test('Given 30 天内用过 When 判定 Then 不算未使用', () => {
    const now = Date.UTC(2026, 10, 21)
    const recent = now - 10 * 24 * 60 * 60 * 1000
    expect(getUnusedSkillSlugs([{ slug: 'recent' }], { recent: { lastUsedAt: recent, useCount: 3 } }, now)).toEqual([])
  })

  test('Given 超过 30 天未用 When 判定 Then 计为未使用', () => {
    const now = Date.UTC(2026, 10, 21)
    const stale = now - (SKILL_UNUSED_DAYS + 1) * 24 * 60 * 60 * 1000
    expect(getUnusedSkillSlugs([{ slug: 'stale' }], { stale: { lastUsedAt: stale, useCount: 1 } }, now)).toEqual(['stale'])
  })
})
