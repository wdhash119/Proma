/**
 * 数据根指针解析测试
 *
 * 只测纯解析函数（readDataRootPointer / resolveConfigDirFromDefault），
 * 不触碰真实 home 目录，也不依赖 electron。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DATA_ROOT_POINTER_FILENAME,
  getDataRootPointerPath,
  getDefaultConfigDir,
  readDataRootPointer,
  resolveConfigDirFromDefault,
} from './config-paths'

let tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writePointer(defaultRoot: string, payload: unknown): string {
  const pointerPath = join(defaultRoot, DATA_ROOT_POINTER_FILENAME)
  writeFileSync(pointerPath, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf-8')
  return pointerPath
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('数据根指针', () => {
  test('Given 没有指针文件 When 解析 Then 使用默认根', () => {
    const defaultRoot = makeTempDir('proma-pointer-none-')
    expect(readDataRootPointer(defaultRoot)).toBeNull()
    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)
  })

  test('Given 合法指针且目标目录存在 When 解析 Then 使用目标目录', () => {
    const defaultRoot = makeTempDir('proma-pointer-ok-')
    const target = makeTempDir('proma-pointer-target-')
    writePointer(defaultRoot, { version: 1, target, migratedAt: '2026-11-25T00:00:00.000Z' })

    expect(readDataRootPointer(defaultRoot)).toEqual({
      version: 1,
      target,
      migratedAt: '2026-11-25T00:00:00.000Z',
    })
    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(target)
  })

  test('Given 指针 JSON 损坏 When 解析 Then 回退默认根且保留损坏文件', () => {
    const defaultRoot = makeTempDir('proma-pointer-broken-')
    const pointerPath = writePointer(defaultRoot, '{ not json')

    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)
    expect(readFileSync(pointerPath, 'utf-8')).toBe('{ not json')
  })

  test('Given 指针目标目录不存在 When 解析 Then 回退默认根', () => {
    const defaultRoot = makeTempDir('proma-pointer-missing-')
    const missingTarget = join(defaultRoot, 'moved-away')
    writePointer(defaultRoot, { version: 1, target: missingTarget, migratedAt: '2026-11-25T00:00:00.000Z' })

    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)
  })

  test('Given 指针目标存在但是文件 When 解析 Then 回退默认根', () => {
    const defaultRoot = makeTempDir('proma-pointer-file-')
    const fileTarget = join(defaultRoot, 'not-a-dir')
    writeFileSync(fileTarget, 'x', 'utf-8')
    writePointer(defaultRoot, { version: 1, target: fileTarget, migratedAt: '2026-11-25T00:00:00.000Z' })

    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)
  })

  test('Given 指针版本或 target 非法 When 解析 Then 回退默认根', () => {
    const defaultRoot = makeTempDir('proma-pointer-invalid-')
    const target = makeTempDir('proma-pointer-invalid-target-')

    writePointer(defaultRoot, { version: 2, target, migratedAt: '2026-11-25T00:00:00.000Z' })
    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)

    writePointer(defaultRoot, { version: 1, target: 'relative/path', migratedAt: '2026-11-25T00:00:00.000Z' })
    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)

    writePointer(defaultRoot, { version: 1, target })
    expect(resolveConfigDirFromDefault(defaultRoot)).toBe(defaultRoot)
  })

  test('Given 默认根 When 拼接指针路径 Then 位于默认根目录下', () => {
    const defaultRoot = getDefaultConfigDir()
    expect(getDataRootPointerPath()).toBe(join(defaultRoot, DATA_ROOT_POINTER_FILENAME))
    expect(getDataRootPointerPath().endsWith('data-root.json')).toBe(true)
  })
})
