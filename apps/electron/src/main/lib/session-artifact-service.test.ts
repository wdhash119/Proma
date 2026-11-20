import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listSessionArtifacts, presentArtifacts, removeSessionArtifact, setSessionArtifactRootForTesting } from './session-artifact-service'

const workspaceSlug = 'artifact-workspace'
const sessionId = 'session-1'
const root = mkdtempSync(join(tmpdir(), 'proma-artifacts-'))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  setSessionArtifactRootForTesting((slug, id) => join(root, slug, id))
})

afterAll(() => {
  setSessionArtifactRootForTesting(undefined)
  rmSync(root, { recursive: true, force: true })
})

describe('会话交付物', () => {
  test('Given 首次登记 When 读取 Then 保留路径、说明与时间', () => {
    const now = 1_700_000_000_000
    const result = presentArtifacts(workspaceSlug, sessionId, [
      { path: join(root, 'report.docx'), description: '季度报告' },
    ], now)

    expect(result).toHaveLength(1)
    expect(result[0]?.description).toBe('季度报告')
    expect(listSessionArtifacts(workspaceSlug, sessionId)).toEqual(result)
  })

  test('Given 同一路径再次登记 When 写入 Then 更新说明而不是新增重复条目', () => {
    const path = join(root, 'slides.pptx')
    presentArtifacts(workspaceSlug, sessionId, [{ path, description: '初版' }], 1)
    const result = presentArtifacts(workspaceSlug, sessionId, [{ path, description: '终版' }], 2)

    expect(result).toHaveLength(1)
    expect(result[0]?.description).toBe('终版')
    expect(result[0]?.presentedAt).toBe(2 as number)
  })

  test('Given 多个交付物 When 读取 Then 最新登记排在最前', () => {
    presentArtifacts(workspaceSlug, sessionId, [{ path: join(root, 'a.pdf') }], 1)
    presentArtifacts(workspaceSlug, sessionId, [{ path: join(root, 'b.pdf') }], 2)

    expect(listSessionArtifacts(workspaceSlug, sessionId).map((item) => item.path.split(/[/\\]/).pop()))
      .toEqual(['b.pdf', 'a.pdf'])
  })

  test('Given 相对路径 When 登记 Then 拒绝写入', () => {
    expect(() => presentArtifacts(workspaceSlug, sessionId, [{ path: 'report.docx' }])).toThrow('绝对文件路径')
  })

  test('Given 登记过多 When 写入 Then 只保留最近 20 条', () => {
    for (let index = 0; index < 25; index += 1) {
      presentArtifacts(workspaceSlug, sessionId, [{ path: join(root, `file-${index}.md`) }], index + 1)
    }
    const artifacts = listSessionArtifacts(workspaceSlug, sessionId)
    expect(artifacts).toHaveLength(20)
    expect(artifacts[0]?.path.endsWith('file-24.md')).toBe(true)
  })

  test('Given 移除一条 When 读取 Then 该条不再出现', () => {
    const keep = join(root, 'keep.pdf')
    const drop = join(root, 'drop.pdf')
    presentArtifacts(workspaceSlug, sessionId, [{ path: keep }, { path: drop }], 1)

    const remaining = removeSessionArtifact(workspaceSlug, sessionId, drop)

    expect(remaining.map((item) => item.path)).toEqual([keep])
    expect(listSessionArtifacts(workspaceSlug, sessionId).map((item) => item.path)).toEqual([keep])
  })

  test('Given 没有登记 When 读取 Then 返回空列表', () => {
    expect(listSessionArtifacts(workspaceSlug, 'other-session')).toEqual([])
  })
})
