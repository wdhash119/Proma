/**
 * Live Compact 决策事件日志的单元测试。
 *
 * 覆盖三件必须成立的事：追加是逐行 JSON、超限轮转到 `.1`、任何写入失败都不抛异常
 * （事件日志是诊断设施，不能反过来弄挂回合）。
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLiveCompactEvent } from './live-compact-events'

const roots: string[] = []

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-live-compact-events-'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('Live Compact 决策事件日志', () => {
  test('Given 连续追加两条判定 When 读文件 Then 逐行 JSON 与写入内容相等', () => {
    const path = join(createRoot(), 'events.jsonl')
    appendLiveCompactEvent(path, { at: '2026-11-24T02:00:00.000Z', sessionId: 's1', event: 'cut', hostTokens: 60400 })
    appendLiveCompactEvent(path, { at: '2026-11-24T02:00:01.000Z', sessionId: 's1', event: 'skip', reason: 'usage_unknown' })

    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      at: '2026-11-24T02:00:00.000Z',
      sessionId: 's1',
      event: 'cut',
      hostTokens: 60400,
    })
    expect(JSON.parse(lines[1] ?? '{}')).toEqual({
      at: '2026-11-24T02:00:01.000Z',
      sessionId: 's1',
      event: 'skip',
      reason: 'usage_unknown',
    })
  })

  test('Given 旧日志已超过 8MB When 追加 Then 旧文件轮转为 .1 且原文件只剩新行', () => {
    const root = createRoot()
    const path = join(root, 'events.jsonl')
    // 留一点余量：轮转判据是 > 8MB。
    const padding = 'x'.repeat(8 * 1024 * 1024 + 16)
    writeFileSync(path, `${padding}\n`, 'utf8')

    appendLiveCompactEvent(path, { at: '2026-11-24T02:00:02.000Z', sessionId: 's1', event: 'skip', reason: 'below_pressure' })

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(statSync(`${path}.1`).size).toBe(padding.length + 1)
    const lines = readLines(path)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}').reason).toBe('below_pressure')
  })

  test('Given 已有一份旧的 .1 When 再次超限轮转 Then 旧 .1 被覆盖而不是写入失败', () => {
    const root = createRoot()
    const path = join(root, 'events.jsonl')
    const padding = 'y'.repeat(8 * 1024 * 1024 + 16)
    writeFileSync(`${path}.1`, 'stale\n', 'utf8')
    writeFileSync(path, `${padding}\n`, 'utf8')

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      appendLiveCompactEvent(path, { at: '2026-11-24T02:00:05.000Z', sessionId: 's1', event: 'skip', reason: 'below_pressure' })
      // renameSync 在 POSIX 与 Windows（MoveFileEx REPLACE_EXISTING）都覆盖目标，
      // 这里钉住“旧 .1 不阻塞轮转、也不告警”，避免以后再改成手工删文件。
      expect(warnSpy.mock.calls.length).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
    expect(statSync(`${path}.1`).size).toBe(padding.length + 1)
    expect(readFileSync(`${path}.1`, 'utf8')).not.toBe('stale\n')
  })

  test('Given eventsPath 指向一个已存在的目录 When 追加 Then 不抛异常只告警', () => {
    const dir = join(createRoot(), 'events-dir')
    mkdirSync(dir, { recursive: true })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => {
        appendLiveCompactEvent(dir, { at: '2026-11-24T02:00:03.000Z', sessionId: 's1', event: 'cut' })
      }).not.toThrow()
      expect(warnSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('Given 父目录不存在 When 追加 Then 自动创建目录并写入', () => {
    const path = join(createRoot(), 'live-compact', 'nested', 'events.jsonl')
    appendLiveCompactEvent(path, { at: '2026-11-24T02:00:04.000Z', sessionId: 's1', event: 'cut', savedTokens: 12000 })
    const lines = readLines(path)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}').savedTokens).toBe(12000)
  })
})