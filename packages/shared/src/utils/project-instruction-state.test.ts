import { describe, expect, test } from 'bun:test'
import { normalizeProjectInstructionSessionState } from './project-instruction-state'

const VALID_SOURCE = {
  path: '/project/sub/AGENTS.md',
  relativePath: 'sub/AGENTS.md',
  scopeRoot: '/project/sub',
  kind: 'agents' as const,
  content: '# 子目录规则\n',
  contentHash: 'abc123',
}

describe('项目指令会话状态规范化', () => {
  test('Given 完整合法状态 When 规范化 Then 原样保留', () => {
    const state = {
      deliveredKeys: ['/project/AGENTS.md\0root'],
      pendingSources: [VALID_SOURCE],
      consumedLegacyMigrations: ['/project/old/CLAUDE.md'],
      pendingLegacyReminders: [{ sourcePath: '/project/old/CLAUDE.md', text: '建议迁移' }],
    }
    expect(normalizeProjectInstructionSessionState(state)).toEqual(state)
  })

  test('Given 空状态/null/非对象 When 规范化 Then 返回 undefined', () => {
    expect(normalizeProjectInstructionSessionState({})).toBeUndefined()
    expect(normalizeProjectInstructionSessionState({
      deliveredKeys: [],
      pendingSources: [],
      consumedLegacyMigrations: [],
      pendingLegacyReminders: [],
    })).toBeUndefined()
    expect(normalizeProjectInstructionSessionState(null)).toBeUndefined()
    expect(normalizeProjectInstructionSessionState('state')).toBeUndefined()
  })

  test('Given 非法来源快照 When 规范化 Then 丢弃该来源保留其余', () => {
    const state = normalizeProjectInstructionSessionState({
      deliveredKeys: ['k'],
      pendingSources: [
        VALID_SOURCE,
        { ...VALID_SOURCE, kind: 'unknown' },
        { ...VALID_SOURCE, contentHash: '' },
        { ...VALID_SOURCE, content: 42 },
        null,
      ],
    })
    expect(state?.pendingSources).toEqual([VALID_SOURCE])
  })

  test('Given 非字符串键与非法提醒 When 规范化 Then 过滤', () => {
    const state = normalizeProjectInstructionSessionState({
      deliveredKeys: ['ok', 42, ''],
      pendingLegacyReminders: [
        { sourcePath: '/p/CLAUDE.md', text: '迁移' },
        { sourcePath: '', text: '无效' },
        { sourcePath: '/p/CLAUDE.md' },
      ],
    })
    expect(state?.deliveredKeys).toEqual(['ok'])
    expect(state?.pendingLegacyReminders).toEqual([{ sourcePath: '/p/CLAUDE.md', text: '迁移' }])
  })

  test('Given 超上限数组 When 规范化 Then 保留最近条目', () => {
    const keys = Array.from({ length: 300 }, (_, i) => `key-${i}`)
    const sources = Array.from({ length: 20 }, (_, i) => ({ ...VALID_SOURCE, contentHash: `h-${i}` }))
    const state = normalizeProjectInstructionSessionState({
      deliveredKeys: keys,
      pendingSources: sources,
    })
    expect(state?.deliveredKeys).toHaveLength(256)
    expect(state?.deliveredKeys?.[255]).toBe('key-299')
    expect(state?.pendingSources).toHaveLength(16)
    expect(state?.pendingSources?.[15]?.contentHash).toBe('h-19')
  })

  test('Given 空 content 的合法来源 When 规范化 Then 保留（空文件也是有效指令）', () => {
    const state = normalizeProjectInstructionSessionState({
      pendingSources: [{ ...VALID_SOURCE, content: '' }],
    })
    expect(state?.pendingSources).toHaveLength(1)
  })
})