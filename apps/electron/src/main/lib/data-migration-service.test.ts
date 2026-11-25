/**
 * 数据目录迁移服务测试
 *
 * 全部使用临时目录 + 显式根覆盖，不读取真实 home、不 mock electron。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  deleteOldData,
  getDataRootInfo,
  migrateDataRoot,
  preflightDataMigration,
  rewritePathInsideRoot,
  rollbackDataRoot,
  validateMigrationTarget,
} from './data-migration-service'
import { scanOrphanData } from './storage-service'
import type { DataMigrationRootContext } from './data-migration-service'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeFile(root: string, relativePath: string, content: string): string {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf-8')
  return target
}

interface MigratedFixture extends DataMigrationRootContext {
  currentDir: string
  defaultRoot: string
}

/** 构造「已迁移」的上下文：当前根 = 自定义目录，默认根只剩指针文件。 */
function migratedContext(): MigratedFixture {
  const defaultRoot = makeTempDir('proma-migrate-default-')
  const currentDir = makeTempDir('proma-migrate-current-')
  writeFileSync(join(defaultRoot, 'data-root.json'), JSON.stringify({
    version: 1,
    target: currentDir,
    migratedAt: '2026-11-24T00:00:00.000Z',
  }), 'utf-8')
  writeFile(currentDir, 'settings.json', '{"themeMode":"dark"}')
  return { currentRoot: currentDir, defaultRoot, runningSessions: 0, currentDir }
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('迁移前目标校验', () => {
  const base = {
    currentRoot: resolve(tmpdir(), 'proma-validate-current'),
    defaultRoot: resolve(tmpdir(), 'proma-validate-default'),
    sourceSizeBytes: 100,
    sourceFileCount: 1,
    targetFreeBytes: 1_000_000,
    runningSessions: 0,
    targetEntries: [] as string[],
  }

  test('Given 相对路径 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({ ...base, target: 'relative/dir' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('绝对路径')
  })

  test('Given 目标等于当前数据目录 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({ ...base, target: base.currentRoot })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('相同')
  })

  test('Given 目标位于当前数据目录内部 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({
      ...base,
      target: join(base.currentRoot, 'nested'),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('内部')
  })

  test('Given 目标为磁盘根 When 校验 Then 拒绝', () => {
    const root = parse(resolve(base.currentRoot)).root
    const result = validateMigrationTarget({ ...base, target: root })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('根目录')
  })

  test('Given 目标非空 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({
      ...base,
      target: resolve(tmpdir(), 'proma-validate-non-empty'),
      targetEntries: ['data', 'data-root.json'],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('非空')
  })

  test('Given 有会话运行 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({
      ...base,
      target: resolve(tmpdir(), 'proma-validate-running'),
      runningSessions: 2,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('正在运行')
  })

  test('Given 运行态无法查询 When 校验 Then 拒绝而不是放行', () => {
    const result = validateMigrationTarget({
      ...base,
      target: resolve(tmpdir(), 'proma-validate-unknown'),
      runningSessions: Number.NaN,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('无法确认')
  })

  test('Given 剩余空间不足 When 校验 Then 拒绝', () => {
    const result = validateMigrationTarget({
      ...base,
      target: resolve(tmpdir(), 'proma-validate-space'),
      targetFreeBytes: 100,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('剩余空间不足')
  })

  test('Given 迁回默认位置且默认根只剩指针 When 校验 Then 允许', () => {
    const result = validateMigrationTarget({
      ...base,
      target: base.defaultRoot,
      targetEntries: ['data-root.json', 'data-root.json.bak'],
    })
    expect(result.ok).toBe(true)
  })

  test('Given 当前就在默认位置但目标只剩指针 When 校验 Then 拒绝（不能覆盖正在使用的根）', () => {
    const result = validateMigrationTarget({
      ...base,
      currentRoot: base.defaultRoot,
      target: base.defaultRoot,
      targetEntries: ['data-root.json'],
    })
    expect(result.ok).toBe(false)
  })
})

describe('数据根信息', () => {
  test('Given 未迁移 When 读取信息 Then isCustom=false 且无旧数据', async () => {
    const defaultRoot = makeTempDir('proma-info-default-')
    writeFile(defaultRoot, 'settings.json', '{}')

    const info = await getDataRootInfo({ currentRoot: defaultRoot, defaultRoot, runningSessions: 0 })
    expect(info.isCustom).toBe(false)
    expect(info.oldDataPresent).toBe(false)
    expect(info.migratedAt).toBeUndefined()
    expect(info.runningSessions).toBe(0)
  })

  test('Given 已迁移且默认根有旧数据 When 读取信息 Then 报告迁移时间与旧数据大小', async () => {
    const context = migratedContext()
    writeFile(context.defaultRoot, 'agent-sessions.json', '{"sessions":[]}')

    const info = await getDataRootInfo(context)
    expect(info.isCustom).toBe(true)
    expect(info.migratedAt).toBe('2026-11-24T00:00:00.000Z')
    expect(info.oldDataPresent).toBe(true)
    expect(info.oldDataSizeBytes ?? 0).toBeGreaterThan(0)
  })
})

describe('迁移执行', () => {
  test('Given 当前根为默认位置 When 迁移到空目录 Then 复制文件并写入指针', async () => {
    const defaultRoot = makeTempDir('proma-migrate-src-')
    const target = makeTempDir('proma-migrate-dst-')
    writeFile(defaultRoot, 'settings.json', '{"a":1}')
    writeFile(defaultRoot, join('agent-sessions', 'x.jsonl'), 'line1\nline2')
    writeFile(defaultRoot, join('agent-workspaces', 'demo', 'memory', 'MEMORY.md'), '# memory')
    writeFile(defaultRoot, join('temp', 'ignored.txt'), 'should not copy')

    const result = await migrateDataRoot(target, undefined, {
      currentRoot: defaultRoot,
      defaultRoot,
      runningSessions: 0,
    })

    expect(result.success).toBe(true)
    expect(result.copiedFiles).toBe(3)
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(readFileSync(join(target, 'agent-sessions', 'x.jsonl'), 'utf-8')).toBe('line1\nline2')
    expect(existsSync(join(target, 'agent-workspaces', 'demo', 'memory', 'MEMORY.md'))).toBe(true)
    // 顶层 temp/ 不参与迁移
    expect(existsSync(join(target, 'temp'))).toBe(false)

    const pointer = JSON.parse(readFileSync(join(defaultRoot, 'data-root.json'), 'utf-8'))
    expect(pointer).toMatchObject({ version: 1, target: resolve(target) })
    expect(typeof pointer.migratedAt).toBe('string')
  })

  test('Given 复制后目标文件缺失 When 校验 When 不写指针且保留目标现场', async () => {
    const defaultRoot = makeTempDir('proma-migrate-verify-src-')
    const target = makeTempDir('proma-migrate-verify-dst-')
    writeFile(defaultRoot, 'a.txt', 'aaaaaaaaaa')
    writeFile(defaultRoot, 'b.txt', 'bbbbbbbbbb')

    let sabotaged = false
    const result = await migrateDataRoot(
      target,
      (progress) => {
        if (sabotaged || progress.phase !== 'copy') return
        const victim = join(target, 'a.txt')
        if (!existsSync(victim)) return
        unlinkSync(victim)
        sabotaged = true
      },
      { currentRoot: defaultRoot, defaultRoot, runningSessions: 0 },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('校验失败')
    expect(existsSync(join(defaultRoot, 'data-root.json'))).toBe(false)
    // 目标现场保留，便于排查
    expect(existsSync(target)).toBe(true)
  })

  test('Given 已迁移 When 迁回默认位置 Then 复制成功并删除指针', async () => {
    const context = migratedContext()
    writeFile(context.currentDir, 'agent-sessions.json', '{"sessions":[]}')
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(true)

    const result = await migrateDataRoot(context.defaultRoot, undefined, context)

    expect(result.success).toBe(true)
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(false)
    expect(existsSync(join(context.defaultRoot, 'settings.json'))).toBe(true)
    expect(existsSync(join(context.defaultRoot, 'agent-sessions.json'))).toBe(true)
  })

  test('Given 数据根内有 Vault When 迁移 Then vault.json 路径跟随改写', async () => {
    const defaultRoot = makeTempDir('proma-migrate-vault-src-')
    const target = makeTempDir('proma-migrate-vault-dst-')
    writeFile(defaultRoot, join('vault', 'note.md'), '# note')
    writeFile(defaultRoot, 'vault.json', JSON.stringify({
      rootPath: join(defaultRoot, 'vault'),
      displayName: 'Proma Vault',
      inboxPath: 'Proma Inbox',
      allowAgentWrites: false,
    }))
    writeFile(defaultRoot, 'settings.json', '{}')

    const result = await migrateDataRoot(target, undefined, {
      currentRoot: defaultRoot,
      defaultRoot,
      runningSessions: 0,
    })

    expect(result.success).toBe(true)
    const migrated = JSON.parse(readFileSync(join(target, 'vault.json'), 'utf-8'))
    expect(migrated.rootPath).toBe(join(target, 'vault'))
    // 相对路径与其他字段保持原样
    expect(migrated.inboxPath).toBe('Proma Inbox')
    expect(migrated.displayName).toBe('Proma Vault')
    expect(existsSync(join(target, 'vault', 'note.md'))).toBe(true)
  })

  test('Given Vault 位于数据根之外 When 迁移 Then 不改写外部路径', async () => {
    const defaultRoot = makeTempDir('proma-migrate-vault-out-src-')
    const target = makeTempDir('proma-migrate-vault-out-dst-')
    const externalVault = makeTempDir('proma-migrate-external-vault-')
    writeFile(defaultRoot, 'vault.json', JSON.stringify({ rootPath: externalVault }))
    writeFile(defaultRoot, 'settings.json', '{}')

    const result = await migrateDataRoot(target, undefined, {
      currentRoot: defaultRoot,
      defaultRoot,
      runningSessions: 0,
    })

    expect(result.success).toBe(true)
    const migrated = JSON.parse(readFileSync(join(target, 'vault.json'), 'utf-8'))
    expect(migrated.rootPath).toBe(externalVault)
  })

  test('Given 有会话运行 When 迁移 Then 拒绝且目标目录不被写入', async () => {
    const context = migratedContext()
    const target = join(makeTempDir('proma-migrate-running-'), 'data')

    const result = await migrateDataRoot(target, undefined, { ...context, runningSessions: 1 })

    expect(result.success).toBe(false)
    expect(result.error).toContain('正在运行')
    expect(existsSync(target)).toBe(false)
  })

  test('Given preflight When 目标非空 Then 返回可读原因与源统计', async () => {
    const context = migratedContext()
    const target = makeTempDir('proma-migrate-nonempty-')
    writeFile(target, 'occupied.txt', 'x')

    const preflight = await preflightDataMigration(target, context)
    expect(preflight.ok).toBe(false)
    expect(preflight.reason).toContain('非空')
    expect(preflight.sourceFileCount).toBe(1)
    expect(preflight.sourceSizeBytes).toBeGreaterThan(0)
  })
})

describe('删除旧数据与回滚', () => {
  test('Given 未迁移 When 删除旧数据 Then 报错且不删除', async () => {
    const defaultRoot = makeTempDir('proma-delete-noncustom-')
    writeFile(defaultRoot, 'settings.json', '{}')

    const result = await deleteOldData({ currentRoot: defaultRoot, defaultRoot, runningSessions: 0 })
    expect(result.deletedCount).toBe(0)
    expect(result.errors.join(' ')).toContain('没有旧数据')
    expect(existsSync(join(defaultRoot, 'settings.json'))).toBe(true)
  })

  test('Given 已迁移 When 删除旧数据 Then 清空默认根但保留指针', async () => {
    const context = migratedContext()
    writeFile(context.defaultRoot, 'settings.json', '{"themeMode":"dark"}')
    writeFile(context.defaultRoot, join('agent-sessions', 'a.jsonl'), 'x')

    const result = await deleteOldData(context)

    expect(result.deletedCount).toBe(2)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(result.errors).toEqual([])
    expect(readdirSync(context.defaultRoot)).toEqual(['data-root.json'])
  })

  test('Given 有会话运行 When 删除旧数据 Then 拒绝', async () => {
    const context = migratedContext()
    writeFile(context.defaultRoot, 'settings.json', '{}')

    const result = await deleteOldData({ ...context, runningSessions: 3 })
    expect(result.deletedCount).toBe(0)
    expect(result.errors.join(' ')).toContain('正在运行')
    expect(existsSync(join(context.defaultRoot, 'settings.json'))).toBe(true)
  })

  test('Given 已迁移且有旧数据 When 回滚 Then 删除指针文件', async () => {
    const context = migratedContext()
    writeFile(context.defaultRoot, 'settings.json', '{}')

    const result = await rollbackDataRoot(context)
    expect(result.success).toBe(true)
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(false)
    expect(existsSync(join(context.defaultRoot, 'settings.json'))).toBe(true)
  })

  test('Given 默认根没有旧数据 When 回滚 Then 拒绝（避免变成空数据根）', async () => {
    const context = migratedContext()

    const result = await rollbackDataRoot(context)
    expect(result.success).toBe(false)
    expect(result.error).toContain('没有旧数据')
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(true)
  })

  test('Given 未迁移 When 回滚 Then 拒绝', async () => {
    const defaultRoot = makeTempDir('proma-rollback-noncustom-')
    const result = await rollbackDataRoot({ currentRoot: defaultRoot, defaultRoot, runningSessions: 0 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('无需回滚')
  })

  test('Given 有会话运行 When 回滚 Then 拒绝且保留指针', async () => {
    const context = migratedContext()
    writeFile(context.defaultRoot, 'settings.json', '{}')

    const result = await rollbackDataRoot({ ...context, runningSessions: 1 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('正在运行')
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(true)
  })
})

describe('迁移后改写数据根内绝对路径（会话索引）', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  function ageFile(target: string, days: number): void {
    const when = new Date(Date.now() - days * DAY_MS)
    utimesSync(target, when, when)
  }

  /** 构造含数据根内/外混合路径的会话索引与 vault 配置。 */
  function buildIndexes(root: string, externalDir: string): void {
    writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          title: 'inside',
          piSessionFile: join(root, 'sdk-config', 'sessions', 'inside.jsonl'),
          forkSourceDir: join(root, 'agent-workspaces', 'demo', 'aaaaaaaa-1111-4111-8111-111111111111'),
          attachedDirectories: [join(root, 'workspace-files'), externalDir],
          attachedFiles: [join(root, 'files', 'a.pdf'), join(externalDir, 'b.pdf')],
          activeWorktree: { path: join(root, 'worktrees', 'wt'), mainRepoRoot: externalDir, branch: 'feat', selectedAt: 1 },
          checkoutHistory: [
            { kind: 'worktree', path: join(root, 'worktrees', 'wt'), mainRepoRoot: externalDir, since: 1 },
            { kind: 'project', path: externalDir, since: 2 },
          ],
          workspaceId: 'ws-1',
        },
        {
          id: 'bbbbbbbb-2222-4222-8222-222222222222',
          title: 'outside',
          piSessionFile: join(externalDir, 'outside.jsonl'),
          updatedAt: 123,
        },
      ],
    }), 'utf-8')

    writeFileSync(join(root, 'vault.json'), JSON.stringify({
      rootPath: join(root, 'vault'),
      inboxPath: externalDir,
      allowAgentWrites: false,
      configuredAt: 42,
    }), 'utf-8')

    writeFileSync(join(root, 'agent-workspaces.json'), JSON.stringify({
      workspaces: [
        { id: 'ws-1', slug: 'demo', projectRootPath: externalDir, createdAt: 1 },
      ],
    }), 'utf-8')
  }

  test('Given 索引含根内与根外路径 When 迁移 Then 仅根内路径改写且其它字段保留', async () => {
    const defaultRoot = makeTempDir('proma-rewrite-src-')
    const target = makeTempDir('proma-rewrite-dst-')
    const externalDir = makeTempDir('proma-rewrite-external-')
    buildIndexes(defaultRoot, externalDir)

    const result = await migrateDataRoot(target, undefined, {
      currentRoot: defaultRoot,
      defaultRoot,
      runningSessions: 0,
    })
    expect(result.success).toBe(true)

    const index = JSON.parse(readFileSync(join(target, 'agent-sessions.json'), 'utf-8'))
    const [inside, outside] = index.sessions
    // 根内路径改写到新根
    expect(inside.piSessionFile).toBe(join(target, 'sdk-config', 'sessions', 'inside.jsonl'))
    expect(inside.forkSourceDir).toBe(join(target, 'agent-workspaces', 'demo', 'aaaaaaaa-1111-4111-8111-111111111111'))
    expect(inside.attachedDirectories).toEqual([join(target, 'workspace-files'), externalDir])
    expect(inside.attachedFiles).toEqual([join(target, 'files', 'a.pdf'), join(externalDir, 'b.pdf')])
    expect(inside.activeWorktree).toMatchObject({
      path: join(target, 'worktrees', 'wt'),
      mainRepoRoot: externalDir,
      branch: 'feat',
      selectedAt: 1,
    })
    expect(inside.checkoutHistory).toEqual([
      { kind: 'worktree', path: join(target, 'worktrees', 'wt'), mainRepoRoot: externalDir, since: 1 },
      { kind: 'project', path: externalDir, since: 2 },
    ])
    expect(inside.workspaceId).toBe('ws-1')
    // 数据根外路径原样保留
    expect(outside.piSessionFile).toBe(join(externalDir, 'outside.jsonl'))
    expect(outside.updatedAt).toBe(123)

    // vault.json 行为不回归
    const vault = JSON.parse(readFileSync(join(target, 'vault.json'), 'utf-8'))
    expect(vault).toEqual({
      rootPath: join(target, 'vault'),
      inboxPath: externalDir,
      allowAgentWrites: false,
      configuredAt: 42,
    })

    // 工作区索引：根外路径 no-op
    const workspaces = JSON.parse(readFileSync(join(target, 'agent-workspaces.json'), 'utf-8'))
    expect(workspaces.workspaces[0].projectRootPath).toBe(externalDir)
    expect(workspaces.workspaces[0].createdAt).toBe(1)
  })

  test('Given 迁移完成 When 在新根扫描孤儿 Then 改写后的 artifact 不算孤儿', async () => {
    const defaultRoot = makeTempDir('proma-rewrite-scan-src-')
    const target = join(makeTempDir('proma-rewrite-scan-dst-'), 'data')
    const sessionId = 'cccccccc-3333-4333-8333-333333333333'
    const artifact = writeFile(defaultRoot, join('sdk-config', 'sessions', 'live.jsonl'), 'artifact')
    const orphanArtifact = writeFile(defaultRoot, join('sdk-config', 'sessions', 'dropped.jsonl'), 'artifact')
    writeFileSync(join(defaultRoot, 'agent-sessions.json'), JSON.stringify({
      sessions: [{ id: sessionId, title: 'live', piSessionFile: artifact }],
    }), 'utf-8')
    ageFile(artifact, 60)
    ageFile(orphanArtifact, 60)

    const result = await migrateDataRoot(target, undefined, {
      currentRoot: defaultRoot,
      defaultRoot,
      runningSessions: 0,
    })
    expect(result.success).toBe(true)

    const scan = await scanOrphanData(30, { configDir: target })
    const artifacts = scan.categories.find((category) => category.key === 'sdk-artifacts')
    expect(artifacts).toBeDefined()
    const paths = artifacts!.entries.map((entry) => entry.path)
    // 索引已指向新根：同一 artifact 必须仍被引用，不能进孤儿列表
    expect(paths).not.toContain(join(target, 'sdk-config', 'sessions', 'live.jsonl'))
    // 无引用且过期的 artifact 仍应被识别（确认引用集本身在工作）
    expect(paths).toContain(join(target, 'sdk-config', 'sessions', 'dropped.jsonl'))
  })

  test('Given 迁回默认位置 When 迁移 Then 索引同样改写到默认根', async () => {
    const context = migratedContext()
    const externalDir = makeTempDir('proma-rewrite-back-external-')
    const sessionId = 'dddddddd-4444-4444-8444-444444444444'
    writeFile(context.currentDir, join('sdk-config', 'sessions', 'back.jsonl'), 'artifact')
    writeFileSync(join(context.currentDir, 'agent-sessions.json'), JSON.stringify({
      sessions: [{
        id: sessionId,
        title: 'back',
        piSessionFile: join(context.currentDir, 'sdk-config', 'sessions', 'back.jsonl'),
        attachedDirectories: [join(context.currentDir, 'workspace-files'), externalDir],
      }],
    }), 'utf-8')

    const result = await migrateDataRoot(context.defaultRoot, undefined, context)
    expect(result.success).toBe(true)
    expect(existsSync(join(context.defaultRoot, 'data-root.json'))).toBe(false)

    const index = JSON.parse(readFileSync(join(context.defaultRoot, 'agent-sessions.json'), 'utf-8'))
    expect(index.sessions[0].piSessionFile)
      .toBe(join(context.defaultRoot, 'sdk-config', 'sessions', 'back.jsonl'))
    expect(index.sessions[0].attachedDirectories)
      .toEqual([join(context.defaultRoot, 'workspace-files'), externalDir])
  })

  test('Given 路径在根内/根外或非绝对 When rewritePathInsideRoot Then 只改写根内绝对路径', () => {
    const source = makeTempDir('proma-rewrite-pure-src-')
    const target = makeTempDir('proma-rewrite-pure-dst-')

    expect(rewritePathInsideRoot(join(source, 'a', 'b'), source, target)).toBe(join(target, 'a', 'b'))
    expect(rewritePathInsideRoot(source, source, target)).toBe(target)
    expect(rewritePathInsideRoot('/elsewhere/x', source, target)).toBe('/elsewhere/x')
    expect(rewritePathInsideRoot('relative/x', source, target)).toBe('relative/x')
    expect(rewritePathInsideRoot(undefined, source, target)).toBeUndefined()
    expect(rewritePathInsideRoot(123, source, target)).toBe(123)
    // 前缀相同但不是子目录（source-sibling）不得被误判
    expect(rewritePathInsideRoot(source + '-sibling/file', source, target)).toBe(source + '-sibling/file')
  })
})

describe('删除旧数据前置守卫', () => {
  function writePointer(defaultRoot: string, target: string): void {
    writeFileSync(join(defaultRoot, 'data-root.json'), JSON.stringify({
      version: 1,
      target,
      migratedAt: '2026-11-24T00:00:00.000Z',
    }), 'utf-8')
  }

  test('Given 当前根缺少关键文件 When 删除旧数据 Then 拒绝且不删任何东西', async () => {
    const defaultRoot = makeTempDir('proma-delete-guard-default-')
    const current = makeTempDir('proma-delete-guard-current-')
    writePointer(defaultRoot, current)
    writeFile(defaultRoot, 'settings.json', '{"themeMode":"dark"}')
    // current 根为空：既没有 settings.json 也没有 agent-sessions.json

    const result = await deleteOldData({ currentRoot: current, defaultRoot, runningSessions: 0 })

    expect(result.deletedCount).toBe(0)
    expect(result.errors.join(' ')).toContain('缺少关键文件')
    expect(existsSync(join(defaultRoot, 'settings.json'))).toBe(true)
  })

  test('Given 当前根只有 agent-sessions.json When 删除旧数据 Then 允许', async () => {
    const defaultRoot = makeTempDir('proma-delete-guard2-default-')
    const current = makeTempDir('proma-delete-guard2-current-')
    writePointer(defaultRoot, current)
    writeFile(defaultRoot, 'settings.json', '{}')
    writeFile(current, 'agent-sessions.json', '{"sessions":[]}')

    const result = await deleteOldData({ currentRoot: current, defaultRoot, runningSessions: 0 })

    expect(result.errors).toEqual([])
    expect(result.deletedCount).toBe(1)
    expect(readdirSync(defaultRoot)).toEqual(['data-root.json'])
  })
})
