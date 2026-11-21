import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyProfileMigrationForTesting,
  listPendingProfileMigrations,
  migrateProfile,
  replanProfileMigration,
  resumeProfileMigration,
  type ProfileMigrationIo,
  type ProfileMigrationJournal,
  type ProfileMigrationProposal,
} from './agent-memory-migration'
import {
  PROJECT_INDEX_TARGET,
  readLegacyProfileLocations,
  readMemoryDocument,
  readMemoryFileAt,
  setMemoryRootsForTesting,
  writeMemoryFileText,
} from './memory-service'

const workspaceSlug = 'demo'
const ORIGINAL_SOURCE = '# 用户画像\n\n- 用户是教师\n- 用户在校工作\n'
const ORIGINAL_INDEX = `# 项目记忆索引\n\n- [旧画像](user-profile.md) — 旧用户画像\n- [部署](deploy.md) — 发布流程\n`
const MERGED_INDEX = '# 项目记忆索引\n\n- [部署](deploy.md) — 发布流程\n'
const MERGED_GLOBAL = '# 全局用户画像\n\n- 用户偏好中文（source：测试；scope：全局）\n- 用户是教师（source：旧画像迁移；scope：全局）\n'
const CLAUDE_SOURCE = '# 用户画像\n\n- 用户在旧版 Claude 目录工作\n'
const CLAUDE_INDEX = '# 项目记忆索引\n\n- [旧画像](user_profile.md) — 旧入口\n- [部署](deploy.md) — 发布流程\n'

let root: string

function workspaceRoot(): string {
  return join(root, 'workspaces', workspaceSlug)
}

function memoryDir(): string {
  return join(workspaceRoot(), 'memory')
}

function globalProfilePath(): string {
  return join(root, 'global-memory', 'user_profile.md')
}

function claudeMemoryDir(): string {
  return join(workspaceRoot(), '.claude', 'memory')
}

function archivePathFor(id: string, fileName: string): string {
  return join(workspaceRoot(), '.profile-migrations', 'archive', id, fileName)
}

function migrationLogPath(id: string): string {
  return join(workspaceRoot(), '.profile-migrations', `${id}.json`)
}

function seed(): void {
  mkdirSync(join(root, 'global-memory'), { recursive: true })
  writeFileSync(globalProfilePath(), '# 全局用户画像\n\n- 用户偏好中文（source：测试；scope：全局）\n', 'utf8')
  mkdirSync(memoryDir(), { recursive: true })
  writeFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), ORIGINAL_INDEX, 'utf8')
  writeFileSync(join(memoryDir(), 'user-profile.md'), ORIGINAL_SOURCE, 'utf8')
}

/** 用当前磁盘状态拼一份 revision 全部正确的提案，再按需覆盖单个字段。 */
function proposalWith(overrides: Partial<ProfileMigrationProposal> = {}): ProfileMigrationProposal {
  const source = readLegacyProfileLocations(workspaceSlug)[0]
  if (!source) throw new Error('测试前置条件缺失：没有旧画像来源')
  const global = readMemoryFileAt(globalProfilePath())
  const index = readMemoryFileAt(join(memoryDir(), PROJECT_INDEX_TARGET))
  const preferences = readMemoryFileAt(join(memoryDir(), 'project-preferences.md'))
  return {
    sourceId: source.id,
    sourceRevision: source.revision,
    globalRevision: global.revision,
    globalContent: MERGED_GLOBAL,
    preferencesRevision: preferences.revision,
    preferencesContent: null,
    sourceIndexRevision: index.revision,
    sourceIndexContent: MERGED_INDEX,
    indexRevision: index.revision,
    indexContent: MERGED_INDEX,
    rationale: '逐项去重：教师身份进全局画像；部署路由保留在项目索引。',
    ...overrides,
  }
}

/** `.claude/memory` 布局：来源索引与当前项目索引是两个不同文件。 */
function proposalWithClaude(overrides: Partial<ProfileMigrationProposal> = {}): ProfileMigrationProposal {
  const source = readLegacyProfileLocations(workspaceSlug).find((item) => item.path.startsWith(claudeMemoryDir()))
  if (!source) throw new Error('测试前置条件缺失：没有 .claude 旧画像来源')
  const global = readMemoryFileAt(globalProfilePath())
  const sourceIndex = readMemoryFileAt(join(claudeMemoryDir(), PROJECT_INDEX_TARGET))
  const index = readMemoryFileAt(join(memoryDir(), PROJECT_INDEX_TARGET))
  const preferences = readMemoryFileAt(join(memoryDir(), 'project-preferences.md'))
  return {
    sourceId: source.id,
    sourceRevision: source.revision,
    globalRevision: global.revision,
    globalContent: MERGED_GLOBAL,
    preferencesRevision: preferences.revision,
    preferencesContent: null,
    sourceIndexRevision: sourceIndex.revision,
    sourceIndexContent: MERGED_INDEX,
    indexRevision: index.revision,
    indexContent: MERGED_INDEX,
    rationale: '逐项去重：旧版 Claude 目录的画像并入全局，来源索引移除旧入口。',
    ...overrides,
  }
}

function seedClaudeLayout(): void {
  mkdirSync(claudeMemoryDir(), { recursive: true })
  writeFileSync(join(claudeMemoryDir(), 'user_profile.md'), CLAUDE_SOURCE, 'utf8')
  writeFileSync(join(claudeMemoryDir(), PROJECT_INDEX_TARGET), CLAUDE_INDEX, 'utf8')
}

/** 把已完成的迁移还原成「已落盘、待续跑」的状态，用于验证 resumeId。 */
function resetMigrationToPending(id: string): ProfileMigrationJournal {
  const logPath = migrationLogPath(id)
  const journal = JSON.parse(readFileSync(logPath, 'utf8')) as ProfileMigrationJournal
  for (const edit of journal.edits) {
    if (edit.before === null) {
      rmSync(edit.path, { force: true })
      continue
    }
    writeFileSync(edit.path, edit.before, 'utf8')
  }
  if (journal.archivedSourceTo) renameSync(journal.archivedSourceTo, journal.sourcePath)
  const pending: ProfileMigrationJournal = { ...journal, status: 'pending' }
  delete pending.archivedSourceTo
  writeFileSync(logPath, JSON.stringify(pending, null, 2), 'utf8')
  return pending
}

function ctx(overrides: { allowProfileMigration?: boolean } = {}): { workspaceSlug: string; allowProfileMigration?: boolean } {
  return { workspaceSlug, ...overrides }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-profile-migration-'))
  setMemoryRootsForTesting({
    globalMemoryDir: join(root, 'global-memory'),
    projectMemoryDir: (slug) => join(root, 'workspaces', slug, 'memory'),
  })
  seed()
})

afterEach(() => {
  setMemoryRootsForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('旧画像语义合并', () => {
  test('Given 来源与目标 revision 全部匹配 When 迁移 Then 写入全局画像、更新索引并归档来源', () => {
    const proposal = proposalWith()

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return
    expect(readFileSync(globalProfilePath(), 'utf8')).toBe(MERGED_GLOBAL)
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(MERGED_INDEX)
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(false)
    expect(readFileSync(result.archivedSourceTo, 'utf8')).toBe(ORIGINAL_SOURCE)
    expect(result.migrationId).toMatch(/^[a-f0-9-]{36}$/)
  })

  test('Given 迁移完成 When 查看日志 Then 记录 rationale、编辑前后内容与完成状态', () => {
    const proposal = proposalWith()

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return
    const journal = JSON.parse(readFileSync(migrationLogPath(result.migrationId), 'utf8')) as ProfileMigrationJournal
    expect(journal.status).toBe('completed')
    expect(journal.rationale).toBe(proposal.rationale)
    expect(journal.edits.map((edit) => edit.target)).toContain('global')
    expect(journal.edits[0]?.before).toContain('用户偏好中文')
    expect(journal.edits[0]?.after).toBe(MERGED_GLOBAL)
    expect(listPendingProfileMigrations(ctx())).toEqual([])
  })

  test('Given 全局画像 revision 已过期 When 迁移 Then 返回 reconciliation_required 且一个字都不写', () => {
    const proposal = proposalWith({ globalRevision: 'a'.repeat(64) })

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('reconciliation_required')
    if (result.status !== 'reconciliation_required') return
    expect(result.saved).toBe(false)
    expect(result.issues.join('\n')).toContain('全局画像')
    expect(readFileSync(globalProfilePath(), 'utf8')).not.toBe(MERGED_GLOBAL)
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(ORIGINAL_INDEX)
    expect(readFileSync(join(memoryDir(), 'user-profile.md'), 'utf8')).toBe(ORIGINAL_SOURCE)
    expect(existsSync(join(workspaceRoot(), '.profile-migrations'))).toBe(false)
  })

  test('Given 多处 revision 过期 When 迁移 Then 一次列出全部冲突', () => {
    const proposal = proposalWith({
      sourceRevision: 'b'.repeat(64),
      indexRevision: 'c'.repeat(64),
    })

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('reconciliation_required')
    if (result.status !== 'reconciliation_required') return
    expect(result.issues.length).toBeGreaterThanOrEqual(2)
    expect(result.issues.join('\n')).toContain('源画像')
    expect(result.issues.join('\n')).toContain('当前项目索引')
  })

  test('Given 合并后画像超过 5000 码元 When 迁移 Then 返回 reconciliation_required 且不落盘', () => {
    const proposal = proposalWith({ globalContent: `# 全局用户画像\n\n- ${'很长的偏好描述'.repeat(2000)}\n` })

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('reconciliation_required')
    if (result.status !== 'reconciliation_required') return
    expect(result.issues.join('\n')).toContain('超预算')
    expect(readFileSync(globalProfilePath(), 'utf8')).not.toContain('很长的偏好描述')
  })

  test('Given 事实条目超过 100 条 When 迁移 Then 返回 reconciliation_required', () => {
    const facts = Array.from({ length: 101 }, (_, index) => `- 事实${index}`).join('\n')
    const proposal = proposalWith({ globalContent: `# 全局用户画像\n\n${facts}\n` })

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('reconciliation_required')
    if (result.status !== 'reconciliation_required') return
    expect(result.maxFacts).toBe(100)
    expect(result.issues.join('\n')).toContain('101 条事实')
  })

  test('Given 索引仍保留旧画像入口 When 迁移 Then 拒绝，不能只删入口不迁移事实', () => {
    const proposal = proposalWith({ indexContent: ORIGINAL_INDEX })

    expect(() => migrateProfile(ctx(), proposal)).toThrow('移除本次源画像的旧入口')
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(true)
  })

  test('Given 已有项目偏好 When 提案丢弃偏好正文 Then 拒绝', () => {
    writeFileSync(join(memoryDir(), 'project-preferences.md'), '# 项目补充偏好\n\n- 提交前跑 typecheck\n', 'utf8')
    const proposal = proposalWith({ preferencesContent: null })

    expect(() => migrateProfile(ctx(), proposal)).toThrow('已有项目偏好不得在迁移中丢弃')
  })

  test('Given 提案保留偏好 When 索引未建立偏好路由 Then 拒绝', () => {
    const proposal = proposalWith({
      preferencesContent: '# 项目补充偏好\n\n- 提交前跑 typecheck\n',
    })

    expect(() => migrateProfile(ctx(), proposal)).toThrow('project-preferences.md')
  })

  test('Given 提案保留偏好且索引建立路由 When 迁移 Then 偏好正文写入并进项目索引', () => {
    writeFileSync(join(memoryDir(), 'project-preferences.md'), '# 项目补充偏好\n\n- 旧偏好\n', 'utf8')
    const preferences = readMemoryFileAt(join(memoryDir(), 'project-preferences.md'))
    const withPreferences = `${MERGED_INDEX}- [项目偏好](project-preferences.md) — 本项目特有偏好\n`
    const proposal = proposalWith({
      preferencesRevision: preferences.revision,
      preferencesContent: '# 项目补充偏好\n\n- 提交前跑 typecheck\n',
      indexContent: withPreferences,
      sourceIndexContent: withPreferences,
    })

    const result = migrateProfile(ctx(), proposal)

    expect(result.status).toBe('migrated')
    expect(readFileSync(join(memoryDir(), 'project-preferences.md'), 'utf8')).toBe('# 项目补充偏好\n\n- 提交前跑 typecheck\n')
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toContain('project-preferences.md')
  })

  test('Given 合并后的单个文件超过 512 KiB When 迁移 Then 拒绝', () => {
    const oversized = `# 索引\n\n${'x'.repeat(513 * 1024)}\n`
    const proposal = proposalWith({ indexContent: oversized, sourceIndexContent: oversized })

    expect(() => migrateProfile(ctx(), proposal)).toThrow('512 KiB')
  })

  test('Given 上下文禁止画像整合 When 迁移 Then 直接拒绝', () => {
    expect(() => migrateProfile(ctx({ allowProfileMigration: false }), proposalWith()))
      .toThrow('不允许整合用户画像')
  })

  test('Given 来源不属于当前工作区 When 迁移 Then 拒绝并要求重新读取', () => {
    expect(() => migrateProfile(ctx(), proposalWith({ sourceId: 'd'.repeat(64) })))
      .toThrow('源画像不存在')
  })
})

describe('挂起迁移的续跑与重新规划', () => {
  test('Given 落盘但未完成的迁移 When resumeId 续跑 Then 完成写入并归档来源', () => {
    const first = migrateProfile(ctx(), proposalWith())
    expect(first.status).toBe('migrated')
    if (first.status !== 'migrated') return
    resetMigrationToPending(first.migrationId)

    const resumed = resumeProfileMigration(ctx(), first.migrationId)

    expect(resumed.status).toBe('migrated')
    expect(readFileSync(globalProfilePath(), 'utf8')).toBe(MERGED_GLOBAL)
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(false)
  })

  test('Given 挂起期间源画像被外部编辑 When resumeId 续跑 Then 返回 reconciliation_required 并保留新内容', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    writeFileSync(join(memoryDir(), 'user-profile.md'), `${ORIGINAL_SOURCE}- 用户新增事实\n`, 'utf8')

    const resumed = resumeProfileMigration(ctx(), first.migrationId)

    expect(resumed.status).toBe('reconciliation_required')
    if (resumed.status !== 'reconciliation_required') return
    expect(resumed.issues.join('\n')).toContain('replanId')
    expect(readFileSync(join(memoryDir(), 'user-profile.md'), 'utf8')).toContain('用户新增事实')
    expect(readFileSync(globalProfilePath(), 'utf8')).not.toBe(MERGED_GLOBAL)
  })

  test('Given 挂起的迁移 When replanId 退役 Then 保留外部编辑并要求重新合并', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    writeFileSync(join(memoryDir(), 'user-profile.md'), `${ORIGINAL_SOURCE}- 外部编辑事实\n`, 'utf8')

    const replan = replanProfileMigration(ctx(), first.migrationId)

    expect(replan.status).toBe('needs-merge')
    expect(replan.next).toContain('MemoryInspect')
    expect(readFileSync(join(memoryDir(), 'user-profile.md'), 'utf8')).toContain('外部编辑事实')
    const journal = JSON.parse(readFileSync(migrationLogPath(first.migrationId), 'utf8')) as ProfileMigrationJournal
    expect(journal.status).toBe('superseded')
  })

  test('Given 已退役的迁移 When 再次 replan Then 幂等返回同一提示', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    replanProfileMigration(ctx(), first.migrationId)

    expect(replanProfileMigration(ctx(), first.migrationId).status).toBe('needs-merge')
  })

  test('Given 已退役的迁移 When resumeId 续跑 Then 拒绝并提示重新提交', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    replanProfileMigration(ctx(), first.migrationId)

    expect(() => resumeProfileMigration(ctx(), first.migrationId)).toThrow('已退役')
  })

  test('Given 源文件被外部删除 When replanId 退役 Then 按日志原文恢复，不丢正文', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    rmSync(join(memoryDir(), 'user-profile.md'))

    replanProfileMigration(ctx(), first.migrationId)

    expect(readFileSync(join(memoryDir(), 'user-profile.md'), 'utf8')).toBe(ORIGINAL_SOURCE)
  })

  test('Given 非法迁移 ID When 续跑 Then 拒绝', () => {
    expect(() => resumeProfileMigration(ctx(), 'not-a-uuid')).toThrow('迁移 ID 无效')
    expect(() => replanProfileMigration(ctx(), 'not-a-uuid')).toThrow('迁移 ID 无效')
  })

  test('Given 迁移日志损坏 When 续跑 Then 拒绝而不是当作已完成', () => {
    const id = '11111111-1111-1111-1111-111111111111'
    mkdirSync(join(workspaceRoot(), '.profile-migrations'), { recursive: true })
    writeFileSync(migrationLogPath(id), '{ not json', 'utf8')

    expect(() => resumeProfileMigration(ctx(), id)).toThrow('无法解析')
  })
})

describe('.claude/memory 旧画像布局', () => {
  beforeEach(() => {
    seedClaudeLayout()
  })

  test('Given .claude/memory 布局 When 迁移 Then 同时更新来源索引、项目索引并归档来源', () => {
    const result = migrateProfile(ctx(), proposalWithClaude())

    expect(result.status).toBe('migrated')
    if (result.status !== 'migrated') return
    expect(readFileSync(globalProfilePath(), 'utf8')).toBe(MERGED_GLOBAL)
    expect(readFileSync(join(claudeMemoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(MERGED_INDEX)
    expect(readFileSync(join(memoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(MERGED_INDEX)
    expect(existsSync(join(claudeMemoryDir(), 'user_profile.md'))).toBe(false)
    expect(readFileSync(result.archivedSourceTo, 'utf8')).toBe(CLAUDE_SOURCE)
    expect(listPendingProfileMigrations(ctx())).toEqual([])
  })

  test('Given .claude/memory 布局迁移挂起 When resumeId 续跑 Then 完成且不因来源索引路径卡死', () => {
    const first = migrateProfile(ctx(), proposalWithClaude())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)

    const resumed = resumeProfileMigration(ctx(), first.migrationId)

    expect(resumed.status).toBe('migrated')
    expect(readFileSync(join(claudeMemoryDir(), PROJECT_INDEX_TARGET), 'utf8')).toBe(MERGED_INDEX)
    expect(existsSync(join(claudeMemoryDir(), 'user_profile.md'))).toBe(false)
  })

  test('Given .claude/memory 布局迁移挂起 When replanId 退役 Then 恢复来源并标记 superseded', () => {
    const first = migrateProfile(ctx(), proposalWithClaude())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)

    const replan = replanProfileMigration(ctx(), first.migrationId)

    expect(replan.status).toBe('needs-merge')
    expect(readFileSync(join(claudeMemoryDir(), 'user_profile.md'), 'utf8')).toBe(CLAUDE_SOURCE)
    const journal = JSON.parse(readFileSync(migrationLogPath(first.migrationId), 'utf8')) as ProfileMigrationJournal
    expect(journal.status).toBe('superseded')
  })

  test('Given 来源对应的索引之外的 .claude 路径 When resumeId 续跑 Then 仍被拒绝', () => {
    const first = migrateProfile(ctx(), proposalWithClaude())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    const logPath = migrationLogPath(first.migrationId)
    const journal = JSON.parse(readFileSync(logPath, 'utf8')) as ProfileMigrationJournal
    const legacyEdit = journal.edits.find((edit) => edit.target === 'source-index')
    if (!legacyEdit) throw new Error('测试前置条件缺失：没有 source-index 编辑')
    // 白名单必须精确到 legacyIndexPath，不能放宽到整个 .claude/memory 目录。
    legacyEdit.path = join(claudeMemoryDir(), 'MEMORY-alt.md')
    writeFileSync(logPath, JSON.stringify(journal, null, 2), 'utf8')

    expect(() => resumeProfileMigration(ctx(), first.migrationId)).toThrow('不在当前工作区记忆目录')
  })
})

describe('挂起迁移的来源缺失与部分写入', () => {
  test('Given pending 且源被删、归档也不存在 When resumeId 续跑 Then 返回 reconciliation 且不假完成', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    rmSync(join(memoryDir(), 'user-profile.md'))

    const resumed = resumeProfileMigration(ctx(), first.migrationId)

    expect(resumed.status).toBe('reconciliation_required')
    if (resumed.status !== 'reconciliation_required') return
    expect(resumed.saved).toBe(false)
    expect(resumed.issues.join('\n')).toContain('归档副本')
    expect(readFileSync(globalProfilePath(), 'utf8')).not.toBe(MERGED_GLOBAL)
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(false)
    const journal = JSON.parse(readFileSync(migrationLogPath(first.migrationId), 'utf8')) as ProfileMigrationJournal
    expect(journal.status).toBe('pending')
  })

  test('Given pending 且源已归档、日志未完成 When resumeId 续跑 Then 使用已有归档完成迁移', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    const archivedTo = archivePathFor(first.migrationId, 'user-profile.md')
    mkdirSync(join(workspaceRoot(), '.profile-migrations', 'archive', first.migrationId), { recursive: true })
    renameSync(join(memoryDir(), 'user-profile.md'), archivedTo)

    const resumed = resumeProfileMigration(ctx(), first.migrationId)

    expect(resumed.status).toBe('migrated')
    if (resumed.status !== 'migrated') return
    expect(resumed.archivedSourceTo).toBe(archivedTo)
    expect(readFileSync(archivedTo, 'utf8')).toBe(ORIGINAL_SOURCE)
    expect(existsSync(join(memoryDir(), 'user-profile.md'))).toBe(false)
    expect(readFileSync(globalProfilePath(), 'utf8')).toBe(MERGED_GLOBAL)
  })

  test('Given 早序目标已写入后后置目标被外部修改 When 续跑 Then 返回 apply_incomplete 且可继续 resume', () => {
    const first = migrateProfile(ctx(), proposalWith())
    if (first.status !== 'migrated') throw new Error('前置迁移未成功')
    resetMigrationToPending(first.migrationId)
    const journal = JSON.parse(
      readFileSync(migrationLogPath(first.migrationId), 'utf8'),
    ) as ProfileMigrationJournal
    const lastEdit = journal.edits[journal.edits.length - 1]
    if (!lastEdit) throw new Error('测试前置条件缺失：没有编辑目标')
    const firstEdit = journal.edits[0]
    if (!firstEdit) throw new Error('测试前置条件缺失：没有首个编辑目标')
    let writeCount = 0
    const io: ProfileMigrationIo = {
      read: readMemoryFileAt,
      write: (path, content) => {
        writeMemoryFileText(path, content)
        writeCount += 1
        if (writeCount === 1) {
          // 模拟另一个进程在首个子文件落盘后修改后置目标。
          writeFileSync(lastEdit.path, '# 外部并发修改\n', 'utf8')
        }
      },
    }

    const result = applyProfileMigrationForTesting(ctx(), journal, io)

    expect(result.status).toBe('apply_incomplete')
    if (result.status !== 'apply_incomplete') return
    expect(result.saved).toBe(true)
    expect(result.writtenTargets).toEqual([firstEdit.path])
    expect(result.pendingTargets).toEqual([lastEdit.path])
    expect(result.issues.join('\n')).toContain('外部修改')
    expect(readFileSync(lastEdit.path, 'utf8')).toBe('# 外部并发修改\n')
    expect(readFileSync(firstEdit.path, 'utf8')).toBe(firstEdit.after)
    const pendingJournal = JSON.parse(
      readFileSync(migrationLogPath(first.migrationId), 'utf8'),
    ) as ProfileMigrationJournal
    expect(pendingJournal.status).toBe('pending')

    // 处理外部改动后仍可续跑：恢复后置目标的 before，resume 完成剩余写入。
    writeMemoryFileText(lastEdit.path, lastEdit.before ?? '')
    const resumed = resumeProfileMigration(ctx(), first.migrationId)
    expect(resumed.status).toBe('migrated')
    expect(readFileSync(lastEdit.path, 'utf8')).toBe(lastEdit.after)
  })
})

describe('旧画像来源扫描', () => {
  test('Given 两种历史布局都存在 When 扫描 Then 都列出且 id 稳定', () => {
    mkdirSync(join(workspaceRoot(), '.claude', 'memory'), { recursive: true })
    writeFileSync(join(workspaceRoot(), '.claude', 'memory', 'user_profile.md'), '# 旧画像\n\n- 旧事实\n', 'utf8')

    const first = readLegacyProfileLocations(workspaceSlug)
    const second = readLegacyProfileLocations(workspaceSlug)

    expect(first).toHaveLength(2)
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id))
    expect(first.some((item) => item.path.includes(join('.claude', 'memory')))).toBe(true)
    expect(first.find((item) => item.path.startsWith(memoryDir()))?.content).toBe(ORIGINAL_SOURCE)
  })

  test('Given 没有旧画像 When 扫描 Then 返回空列表', () => {
    rmSync(join(memoryDir(), 'user-profile.md'))

    expect(readLegacyProfileLocations(workspaceSlug)).toEqual([])
  })

  test('Given 旧画像正文为空 When 扫描 Then 不列为可迁移来源', () => {
    writeFileSync(join(memoryDir(), 'user-profile.md'), '   \n', 'utf8')

    expect(readLegacyProfileLocations(workspaceSlug)).toEqual([])
  })

  test('Given 旧画像是符号链接 When 扫描 Then 报错，不跟随链接', () => {
    const outside = join(root, 'outside-profile.md')
    writeFileSync(outside, '# 外部画像\n\n- 外部事实\n', 'utf8')
    writeFileSync(join(memoryDir(), 'user-profile.md'), ORIGINAL_SOURCE, 'utf8')
    symlinkSync(outside, join(memoryDir(), 'user_profile.md'))

    expect(() => readLegacyProfileLocations(workspaceSlug)).toThrow('符号链接')
  })

  test('Given 源索引是同一份 MEMORY.md When 迁移 Then 内容不一致会拒绝', () => {
    const proposal = proposalWith({ sourceIndexContent: `${MERGED_INDEX}- [其他](other.md)\n` })

    expect(() => migrateProfile(ctx(), proposal)).toThrow('内容必须一致')
  })
})

describe('记忆目录布局', () => {
  test('Given 迁移日志目录 When 列目录 Then 归档副本与日志已分离存放', () => {
    const result = migrateProfile(ctx(), proposalWith())
    if (result.status !== 'migrated') throw new Error('前置迁移未成功')

    const entries = readdirSync(join(workspaceRoot(), '.profile-migrations')).sort()

    expect(entries).toContain('archive')
    expect(entries).toContain(`${result.migrationId}.json`)
    expect(readMemoryDocument(PROJECT_INDEX_TARGET, workspaceSlug).content).toBe(MERGED_INDEX)
  })
})
