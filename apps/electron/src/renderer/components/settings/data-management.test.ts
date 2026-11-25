import { describe, expect, test } from 'bun:test'
import type { DataMigrationProgress } from '@/types/settings'
import {
  MIGRATION_PHASE_LABELS,
  describeRunningSessionsBlock,
  formatBytes,
  formatMigratedAt,
  getMigrationPercent,
} from './data-management'

function progress(patch: Partial<DataMigrationProgress>): DataMigrationProgress {
  return {
    phase: 'copy',
    copiedFiles: 0,
    totalFiles: 0,
    copiedBytes: 0,
    totalBytes: 0,
    ...patch,
  }
}

describe('数据管理页字节格式化', () => {
  test('Given 零值或非法值 When 格式化 Then 统一显示 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-10)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  test('Given 各量级字节数 When 格式化 Then 按 1024 进制保留对应精度', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB')
  })
})

describe('数据迁移进度换算', () => {
  test('Given 扫描阶段 When 换算 Then 进度为 0', () => {
    expect(getMigrationPercent(progress({ phase: 'scan', totalBytes: 1000 }))).toBe(0)
  })

  test('Given 复制阶段 When 换算 Then 按已复制字节比例推进并封顶 100', () => {
    expect(getMigrationPercent(progress({ phase: 'copy', copiedBytes: 250, totalBytes: 1000 }))).toBe(25)
    expect(getMigrationPercent(progress({ phase: 'copy', copiedBytes: 2000, totalBytes: 1000 }))).toBe(100)
  })

  test('Given 总字节未知 When 复制阶段换算 Then 不产生 NaN 或负值', () => {
    expect(getMigrationPercent(progress({ phase: 'copy', copiedBytes: 10, totalBytes: 0 }))).toBe(0)
  })

  test('Given 校验或完成阶段 When 换算 Then 进度视为已复制完成，不回退', () => {
    expect(getMigrationPercent(progress({ phase: 'verify', copiedBytes: 1000, totalBytes: 1000 }))).toBe(100)
    expect(getMigrationPercent(progress({ phase: 'done', copiedBytes: 1000, totalBytes: 1000 }))).toBe(100)
  })

  test('Given 失败阶段 When 换算 Then 保留已复制比例便于定位中断点', () => {
    expect(getMigrationPercent(progress({ phase: 'error', copiedBytes: 400, totalBytes: 1000 }))).toBe(40)
  })

  test('Given 全部阶段 When 读取文案 Then 每个阶段都有中文说明', () => {
    for (const phase of ['scan', 'copy', 'verify', 'done', 'error'] as const) {
      expect(MIGRATION_PHASE_LABELS[phase].length).toBeGreaterThan(0)
    }
  })
})

describe('运行中会话守卫', () => {
  test('Given 没有运行中会话 When 生成守卫文案 Then 返回 null 允许操作', () => {
    expect(describeRunningSessionsBlock(0)).toBeNull()
    expect(describeRunningSessionsBlock(Number.NaN)).toBeNull()
  })

  test('Given 有运行中会话 When 生成守卫文案 Then 说明数量和可操作条件', () => {
    const text = describeRunningSessionsBlock(2)
    expect(text).not.toBeNull()
    expect(text).toContain('2 个会话正在运行')
    expect(text).toContain('停止')
  })
})

describe('迁移时间展示', () => {
  test('Given 缺省或非法时间 When 格式化 Then 返回 null 由调用方跳过渲染', () => {
    expect(formatMigratedAt(undefined)).toBeNull()
    expect(formatMigratedAt('not-a-date')).toBeNull()
  })

  test('Given 合法 ISO 时间 When 格式化 Then 输出非空本地时间', () => {
    const formatted = formatMigratedAt('2026-11-25T03:30:00.000Z')
    expect(formatted).toBeTruthy()
    expect(formatted).toContain('2026')
  })
})
