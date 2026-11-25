import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettingsTab } from '../../atoms/settings-tab'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

const SETTINGS_DIR = 'src/renderer/components/settings'

describe('数据管理设置页注册与页面契约', () => {
  test('Given 设置标签页白名单 When 检查 Then 已移除 migration 且旧值映射到 storage', () => {
    const atoms = readAppFile('src/renderer/atoms/settings-tab.ts')

    expect(atoms).not.toContain("'migration',")
    expect(atoms).toContain("'storage',")
    // 仍在指向已并入页面的旧状态不能被回退成默认页。
    expect(normalizeSettingsTab('migration')).toBe('storage')
    expect(normalizeSettingsTab('storage')).toBe('storage')
  })

  test('Given 设置面板导航 When 检查 Then 只有一个数据管理入口且不引用旧页面', () => {
    const panel = readAppFile(`${SETTINGS_DIR}/SettingsPanel.tsx`)

    expect(panel).toContain('DataManagementSettings')
    expect(panel).toContain('label: "数据管理"')
    expect(panel).not.toContain('MigrationSettings')
    expect(panel).not.toContain('StorageSettings')
    expect(panel).not.toContain('id: "migration"')
    expect(panel).not.toContain('磁盘管理')
  })

  test('Given 旧页面文件 When 检查 Then 已合并删除', () => {
    expect(existsSync(join(appRoot, SETTINGS_DIR, 'MigrationSettings.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, SETTINGS_DIR, 'StorageSettings.tsx'))).toBe(false)
    expect(existsSync(join(appRoot, SETTINGS_DIR, 'DataManagementSettings.tsx'))).toBe(true)
  })

  test('Given 数据管理页 When 检查 Then 四个区块齐全', () => {
    const page = readAppFile(`${SETTINGS_DIR}/DataManagementSettings.tsx`)

    for (const title of ['存储用量', '数据清理', '数据目录', '跨设备迁移']) {
      expect(page).toContain(`title="${title}"`)
    }
    // 原数据迁移页的引导内容整体并入跨设备迁移区块。
    expect(page).toContain('ARCHIVE_MIGRATION_PROMPT')
    expect(page).toContain('RESTORE_MIGRATION_PROMPT')
  })

  test('Given 数据管理页 When 检查 Then 按契约调用 preload 桥接', () => {
    const page = readAppFile(`${SETTINGS_DIR}/DataManagementSettings.tsx`)

    for (const call of [
      'storage.scanOrphans(',
      'storage.cleanupOrphans(',
      'dataRoot.getInfo(',
      'dataRoot.preflight(',
      'dataRoot.migrate(',
      'dataRoot.deleteOld(',
      'dataRoot.rollback(',
      'dataRoot.restart(',
      'dataRoot.onProgress(',
      'dataRoot.selectDirectory(',
    ]) {
      expect(page).toContain(call)
    }
    // 打开数据文件夹复用既有迁移桥接。
    expect(page).toContain('openMigrationDataFolder')
  })

  test('Given 数据管理页 When 检查 Then 新增设置字段与既有清理设置都在页面读写', () => {
    const page = readAppFile(`${SETTINGS_DIR}/DataManagementSettings.tsx`)

    for (const field of [
      'orphanCleanupDays',
      'autoCleanupOrphansOnStart',
      'autoCleanupTempOnStart',
      'autoCleanupArchivedDays',
    ]) {
      expect(page).toContain(field)
    }
    // 过期阈值提供 7/30/90 天三档。
    expect(page).toContain('<SelectItem value="7">7 天</SelectItem>')
    expect(page).toContain('<SelectItem value="30">30 天</SelectItem>')
    expect(page).toContain('<SelectItem value="90">90 天</SelectItem>')
  })
})
