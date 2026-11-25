/**
 * 过期孤儿数据清理与归档会话清理测试
 *
 * 全部在临时 configDir 上运行：显式传入 storage roots，不读真实 home，
 * 也不 mock electron（避免 mock.module 跨文件泄漏）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupArchivedSessions, cleanupOrphanData, scanOrphanData } from './storage-service'
import type { OrphanScanResult } from '../../types'

const DAY_MS = 24 * 60 * 60 * 1000
const ARCHIVED_ID = '0f0f0f0f-1111-4111-8111-111111111111'
const RUNNING_ID = '1f1f1f1f-2222-4222-8222-222222222222'
const ACTIVE_ID = '2f2f2f2f-3333-4333-8333-333333333333'
const RECENT_ID = '3f3f3f3f-4444-4444-8444-444444444444'
const ORPHAN_ID = '4f4f4f4f-5555-4555-8555-555555555555'
const FRESH_ORPHAN_ID = '5f5f5f5f-6666-4666-8666-666666666666'
const WORKSPACE_SLUG = 'demo'

let tempDirs: string[] = []
const now = Date.now()

function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-storage-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'agent-sessions'), { recursive: true })
  mkdirSync(join(dir, 'sdk-config', 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'agent-workspaces', WORKSPACE_SLUG), { recursive: true })
  return dir
}

function writeFile(root: string, relativePath: string, content = 'x'): string {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf-8')
  return target
}

/** 把文件或目录树的 mtime 整体推到 days 天前，模拟过期。 */
function age(target: string, days: number): void {
  const when = new Date(now - days * DAY_MS)
  const stamp = () => utimesSync(target, when, when)
  if (!existsSync(target)) return
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const stat = require('node:fs').statSync(current)
    if (stat.isDirectory()) {
      for (const entry of require('node:fs').readdirSync(current)) {
        stack.push(join(current, entry))
      }
    }
    utimesSync(current, when, when)
  }
  stamp()
}

function writeIndexes(configDir: string, sessions: unknown[], workspaces: unknown[] = [
  { id: 'ws-1', slug: WORKSPACE_SLUG, name: 'Demo' },
]): void {
  writeFileSync(join(configDir, 'agent-sessions.json'), JSON.stringify({ version: 3, sessions }), 'utf-8')
  writeFileSync(join(configDir, 'agent-workspaces.json'), JSON.stringify({ version: 1, workspaces }), 'utf-8')
}

function category(result: OrphanScanResult, key: string) {
  return result.categories.find((item) => item.key === key)
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('孤儿扫描安全边界', () => {
  test('Given 工作区下的非 UUID 目录 When 扫描与清理 Then 绝不触碰', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const memoryFile = writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, 'memory', 'COLLABORATION.md'))
    const planFile = writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, 'instruction-maintenance', 'x.md'))
    const reviewFile = writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, 'project-map-reviews', 'y.md'))
    for (const target of [memoryFile, planFile, reviewFile]) age(target, 400)
    age(join(configDir, 'agent-workspaces', WORKSPACE_SLUG), 400)

    const scan = await scanOrphanData(30, { configDir })
    expect(category(scan, 'orphan-workspaces')?.count ?? 0).toBe(0)

    const cleanup = await cleanupOrphanData(30, { configDir })
    expect(cleanup.deletedCount).toBe(0)
    for (const target of [memoryFile, planFile, reviewFile]) {
      expect(existsSync(target)).toBe(true)
    }
  })

  test('Given UUID 目录仍被索引引用 When 扫描 Then 不算孤儿', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [
      { id: ARCHIVED_ID, title: 'archived', archived: true, updatedAt: now - 40 * DAY_MS },
    ])
    const sessionDir = join(configDir, 'agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID)
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID, 'plan.md'), 'plan')
    age(sessionDir, 400)

    const scan = await scanOrphanData(30, { configDir })
    expect(category(scan, 'orphan-workspaces')?.count ?? 0).toBe(0)
  })

  test('Given UUID 目录无索引引用但最近仍有活动 When 扫描 Then 未过期不入选', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const sessionDir = join(configDir, 'agent-workspaces', WORKSPACE_SLUG, FRESH_ORPHAN_ID)
    const freshFile = writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, FRESH_ORPHAN_ID, 'new.md'), 'new')
    age(sessionDir, 400)
    // 目录本身很老，但内部文件更新 → 最近活动不算过期
    const stamp = new Date(now - 2 * DAY_MS)
    utimesSync(freshFile, stamp, stamp)

    const scan = await scanOrphanData(30, { configDir })
    expect(category(scan, 'orphan-workspaces')?.count ?? 0).toBe(0)
  })

  test('Given 无引用且过期的 UUID 会话目录 When 清理 Then 整目录删除', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const orphanDir = join(configDir, 'agent-workspaces', WORKSPACE_SLUG, ORPHAN_ID)
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, ORPHAN_ID, 'plan.md'), 'plan')
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, ORPHAN_ID, 'spine', 'a.json'), '{}')
    age(orphanDir, 90)

    const scan = await scanOrphanData(30, { configDir })
    const preview = category(scan, 'orphan-workspaces')
    expect(preview?.count).toBe(1)
    expect(preview?.entries[0]?.path).toBe(orphanDir)
    expect(preview?.entries[0]?.sizeBytes).toBeGreaterThan(0)

    const cleanup = await cleanupOrphanData(30, { configDir })
    expect(cleanup.deletedCount).toBe(1)
    expect(existsSync(orphanDir)).toBe(false)
  })
})

describe('孤儿 artifact 与引用集', () => {
  function fixtureWithArtifacts() {
    const configDir = makeConfigDir()
    const referenced = join(configDir, 'sdk-config', 'sessions', 'referenced.jsonl')
    writeFile(configDir, join('sdk-config', 'sessions', 'referenced.jsonl'), 'ref')
    writeFile(configDir, join('sdk-config', 'sessions', 'referenced.jsonl.spine.jsonl'), 'sidecar')
    writeFile(configDir, join('sdk-config', 'sessions', 'orphan.jsonl'), 'orphan')
    writeFile(configDir, join('sdk-config', 'sessions', 'orphan.jsonl.spine.jsonl'), 'sidecar-orphan')
    writeFile(configDir, join('sdk-config', 'sessions', 'dangling.jsonl.spine.jsonl'), 'sidecar-dangling')
    writeIndexes(configDir, [
      {
        id: ACTIVE_ID,
        title: 'active',
        updatedAt: now - 100 * DAY_MS,
        piSessionFile: referenced,
        piEntryBindings: { 'ui-entry': 'tree-entry-1' },
      },
    ])
    for (const name of ['referenced.jsonl', 'referenced.jsonl.spine.jsonl', 'orphan.jsonl', 'orphan.jsonl.spine.jsonl', 'dangling.jsonl.spine.jsonl']) {
      age(join(configDir, 'sdk-config', 'sessions', name), 90)
    }
    return { configDir, referenced }
  }

  test('Given 被 piSessionFile 引用的 artifact When 扫描 Then 不算孤儿', async () => {
    const { configDir, referenced } = fixtureWithArtifacts()
    const scan = await scanOrphanData(30, { configDir })
    const artifactPaths = (category(scan, 'sdk-artifacts')?.entries ?? []).map((entry) => entry.path)
    expect(artifactPaths).not.toContain(referenced)
    expect(artifactPaths.some((path) => path.endsWith('orphan.jsonl'))).toBe(true)

    const sidecarPaths = (category(scan, 'spine-sidecars')?.entries ?? []).map((entry) => entry.path)
    expect(sidecarPaths.some((path) => path.endsWith('referenced.jsonl.spine.jsonl'))).toBe(false)
    expect(sidecarPaths.some((path) => path.endsWith('orphan.jsonl.spine.jsonl'))).toBe(true)
    expect(sidecarPaths.some((path) => path.endsWith('dangling.jsonl.spine.jsonl'))).toBe(true)
  })

  test('Given 引用 base 已不存在 When 扫描 Then 只有 sidecar 进入 spine 类别', async () => {
    const { configDir } = fixtureWithArtifacts()
    const scan = await scanOrphanData(30, { configDir })
    const artifactPaths = (category(scan, 'sdk-artifacts')?.entries ?? []).map((entry) => entry.path)
    expect(artifactPaths.some((path) => path.endsWith('dangling.jsonl'))).toBe(false)
  })

  test('Given 扫描后某 artifact 变成被引用 When 清理 Then 重校验跳过并记录', async () => {
    const { configDir, referenced } = fixtureWithArtifacts()
    await scanOrphanData(30, { configDir })

    const newSessionId = '6f6f6f6f-7777-4777-8777-777777777777'
    writeIndexes(configDir, [
      {
        id: ACTIVE_ID,
        title: 'active',
        updatedAt: now - 100 * DAY_MS,
        piSessionFile: referenced,
        piEntryBindings: {},
      },
      {
        id: newSessionId,
        title: 'late reference',
        updatedAt: now,
        piSessionFile: join(configDir, 'sdk-config', 'sessions', 'orphan.jsonl'),
        piEntryBindings: {},
      },
    ])

    const cleanup = await cleanupOrphanData(30, { configDir })
    expect(existsSync(join(configDir, 'sdk-config', 'sessions', 'orphan.jsonl'))).toBe(true)
    expect(cleanup.errors.some((error) => error.includes('重新校验'))).toBe(true)
    // base 变成被引用后，它的 sidecar 也随之离开孤儿集（活会话的 live-compact 数据不能删）
    expect(existsSync(join(configDir, 'sdk-config', 'sessions', 'orphan.jsonl.spine.jsonl'))).toBe(true)
    // 其余仍然无引用的孤儿照常删除
    expect(existsSync(join(configDir, 'sdk-config', 'sessions', 'dangling.jsonl.spine.jsonl'))).toBe(false)
  })
})

describe('孤儿会话 JSONL 与 legacy SDK 目录', () => {
  test('Given 无索引引用的旧 JSONL When 扫描与清理 Then 删除；未过期或已引用不删', async () => {
    const configDir = makeConfigDir()
    const orphan = writeFile(configDir, join('agent-sessions', `${ORPHAN_ID}.jsonl`), 'line')
    const freshOrphan = writeFile(configDir, join('agent-sessions', `${FRESH_ORPHAN_ID}.jsonl`), 'line')
    const referenced = writeFile(configDir, join('agent-sessions', `${ACTIVE_ID}.jsonl`), 'line')
    writeIndexes(configDir, [{ id: ACTIVE_ID, title: 'active', updatedAt: now }])
    age(orphan, 40)
    age(referenced, 40)

    const scan = await scanOrphanData(30, { configDir })
    const preview = category(scan, 'agent-sessions')
    expect(preview?.count).toBe(1)
    expect(preview?.entries[0]?.path).toBe(orphan)

    await cleanupOrphanData(30, { configDir })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(freshOrphan)).toBe(true)
    expect(existsSync(referenced)).toBe(true)
  })

  test('Given legacy SDK projects 与 file-history When 过期 Then 整目录删除', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    writeFile(configDir, join('sdk-config', 'projects', 'p1', 'session.jsonl'), 'x')
    writeFile(configDir, join('sdk-config', 'file-history', 'h1.jsonl'), 'x')
    age(join(configDir, 'sdk-config', 'projects'), 200)
    age(join(configDir, 'sdk-config', 'file-history'), 200)

    const scan = await scanOrphanData(30, { configDir })
    expect(category(scan, 'legacy-sdk')?.count).toBe(2)

    const cleanup = await cleanupOrphanData(30, { configDir })
    expect(cleanup.deletedCount).toBe(2)
    expect(existsSync(join(configDir, 'sdk-config', 'projects'))).toBe(false)
    expect(existsSync(join(configDir, 'sdk-config', 'file-history'))).toBe(false)
  })

  test('Given 未先扫描 When 清理 Then 拒绝执行（避免误删未确认数据）', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const orphan = writeFile(configDir, join('agent-sessions', `${ORPHAN_ID}.jsonl`), 'x')
    age(orphan, 60)

    const result = await cleanupOrphanData(30, { configDir })
    expect(result.deletedCount).toBe(0)
    expect(result.errors.some((error) => error.includes('扫描'))).toBe(true)
    expect(existsSync(orphan)).toBe(true)
  })

  test('Given 扫描后新增孤儿 When 清理 Then 只删扫描时预览到的路径', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const scanned = writeFile(configDir, join('agent-sessions', `${ORPHAN_ID}.jsonl`), 'x')
    age(scanned, 60)
    await scanOrphanData(30, { configDir })

    const appearedLater = writeFile(configDir, join('agent-sessions', `${FRESH_ORPHAN_ID}.jsonl`), 'y')
    age(appearedLater, 60)

    const result = await cleanupOrphanData(30, { configDir })
    expect(existsSync(scanned)).toBe(false)
    expect(existsSync(appearedLater)).toBe(true)
    expect(result.deletedCount).toBe(1)
  })

  test('Given session-attachments 存在 When 扫描与清理 Then 只预览不删除', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [])
    const attachment = writeFile(configDir, join('sdk-config', 'session-attachments', 'blob.bin'), 'data')
    age(attachment, 100)
    age(join(configDir, 'sdk-config', 'session-attachments'), 100)

    const scan = await scanOrphanData(30, { configDir })
    expect(category(scan, 'session-attachments')?.count).toBe(1)

    const cleanup = await cleanupOrphanData(30, { configDir })
    expect(existsSync(attachment)).toBe(true)
    expect(cleanup.errors.some((error) => error.includes('引用关系无法确认'))).toBe(true)
  })

  test('Given 全新安装 When 扫描 Then 各类别均为空且不抛错', async () => {
    const configDir = makeConfigDir()
    const scan = await scanOrphanData(30, { configDir })
    expect(scan.totalCount).toBe(0)
    expect(scan.totalSizeBytes).toBe(0)
    expect(scan.categories.every((item) => item.count === 0)).toBe(true)
  })
})

describe('归档会话清理', () => {
  function fixture() {
    const configDir = makeConfigDir()
    const artifact = join(configDir, 'sdk-config', 'sessions', 'archived-artifact.jsonl')
    writeFile(configDir, join('sdk-config', 'sessions', 'archived-artifact.jsonl'), 'artifact')
    writeFile(configDir, join('sdk-config', 'sessions', 'archived-artifact.jsonl.spine.jsonl'), 'sidecar')
    writeFile(configDir, join('agent-sessions', `${ARCHIVED_ID}.jsonl`), 'jsonl')
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID, 'plan.md'), 'plan')
    writeFile(configDir, join('agent-sessions', `${RUNNING_ID}.jsonl`), 'jsonl')
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, RUNNING_ID, 'plan.md'), 'plan')
    writeFile(configDir, join('agent-sessions', `${ACTIVE_ID}.jsonl`), 'jsonl')
    writeFile(configDir, join('agent-sessions', `${RECENT_ID}.jsonl`), 'jsonl')

    const sessions = [
      {
        id: ARCHIVED_ID,
        title: 'archived',
        workspaceId: 'ws-1',
        archived: true,
        updatedAt: now - 40 * DAY_MS,
        piSessionFile: artifact,
        piEntryBindings: { 'ui-entry': 'tree-entry' },
      },
      {
        id: RUNNING_ID,
        title: 'running archived',
        workspaceId: 'ws-1',
        archived: true,
        updatedAt: now - 40 * DAY_MS,
      },
      { id: ACTIVE_ID, title: 'active', workspaceId: 'ws-1', archived: false, updatedAt: now - 40 * DAY_MS },
      { id: RECENT_ID, title: 'recent', workspaceId: 'ws-1', archived: true, updatedAt: now - 2 * DAY_MS },
    ]
    writeIndexes(configDir, sessions)
    return { configDir }
  }

  test('Given 超期归档会话 When 清理 Then 删除 JSONL/artifact/sidecar/工作目录并保留索引与运行中会话', async () => {
    const { configDir } = fixture()

    const result = await cleanupArchivedSessions(30, {
      roots: { configDir },
      runningSessionIds: new Set([RUNNING_ID]),
    })

    expect(result).toEqual({ freedBytes: expect.any(Number), deletedCount: 4, errors: [] })
    expect(existsSync(join(configDir, 'agent-sessions', `${ARCHIVED_ID}.jsonl`))).toBe(false)
    expect(existsSync(join(configDir, 'sdk-config', 'sessions', 'archived-artifact.jsonl'))).toBe(false)
    expect(existsSync(join(configDir, 'sdk-config', 'sessions', 'archived-artifact.jsonl.spine.jsonl'))).toBe(false)
    expect(existsSync(join(configDir, 'agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID))).toBe(false)

    // 运行中会话、未归档会话、未过期归档会话都保留
    expect(existsSync(join(configDir, 'agent-sessions', `${RUNNING_ID}.jsonl`))).toBe(true)
    expect(existsSync(join(configDir, 'agent-workspaces', WORKSPACE_SLUG, RUNNING_ID))).toBe(true)
    expect(existsSync(join(configDir, 'agent-sessions', `${ACTIVE_ID}.jsonl`))).toBe(true)
    expect(existsSync(join(configDir, 'agent-sessions', `${RECENT_ID}.jsonl`))).toBe(true)

    const index = JSON.parse(readFileSync(join(configDir, 'agent-sessions.json'), 'utf-8'))
    expect(index.sessions).toHaveLength(4)
  })

  test('Given artifact 指向数据根外 When 清理 Then 跳过 artifact 但删除其余数据并记录原因', async () => {
    const configDir = makeConfigDir()
    const outsideDir = mkdtempSync(join(tmpdir(), 'proma-outside-artifact-'))
    tempDirs.push(outsideDir)
    const outsideArtifact = writeFile(outsideDir, 'user-file.jsonl', 'artifact')
    writeFile(configDir, join('agent-sessions', `${ARCHIVED_ID}.jsonl`), 'jsonl')
    writeFile(configDir, join('agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID, 'plan.md'), 'plan')
    writeIndexes(configDir, [{
      id: ARCHIVED_ID,
      title: 'archived outside',
      workspaceId: 'ws-1',
      archived: true,
      updatedAt: now - 40 * DAY_MS,
      piSessionFile: outsideArtifact,
    }])

    const result = await cleanupArchivedSessions(30, {
      roots: { configDir },
      runningSessionIds: new Set(),
    })

    // 数据根外的用户文件绝不删除
    expect(existsSync(outsideArtifact)).toBe(true)
    expect(existsSync(join(configDir, 'agent-sessions', `${ARCHIVED_ID}.jsonl`))).toBe(false)
    expect(existsSync(join(configDir, 'agent-workspaces', WORKSPACE_SLUG, ARCHIVED_ID))).toBe(false)
    expect(result.deletedCount).toBe(2)
    expect(result.errors.join(' ')).toContain('不在数据目录内')
  })

  test('Given 归档会话没有 artifact When 清理 Then 不产生错误', async () => {
    const configDir = makeConfigDir()
    writeIndexes(configDir, [
      { id: ARCHIVED_ID, title: 'archived', workspaceId: 'ws-1', archived: true, updatedAt: now - 40 * DAY_MS },
    ])
    writeFile(configDir, join('agent-sessions', `${ARCHIVED_ID}.jsonl`), 'jsonl')

    const result = await cleanupArchivedSessions(30, {
      roots: { configDir },
      runningSessionIds: new Set(),
    })
    expect(result.errors).toEqual([])
    expect(result.deletedCount).toBe(1)
  })
})
