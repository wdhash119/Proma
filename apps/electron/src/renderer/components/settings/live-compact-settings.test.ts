import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettingsTab } from '../../atoms/settings-tab'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('Live Compact 设置页注册与主闸语义', () => {
  test('Given 设置标签页清单 When 检查 Then 含 live-compact 且可被归一化保留', () => {
    const atoms = readAppFile('src/renderer/atoms/settings-tab.ts')

    expect(atoms).toContain("'live-compact'")
    // 运行时校验不得把它当作未知值回退到默认标签页。
    expect(normalizeSettingsTab('live-compact')).toBe('live-compact')
  })

  test('Given 设置面板 When 检查 Then 有独立 Tab 项与渲染分支', () => {
    const panel = readAppFile('src/renderer/components/settings/SettingsPanel.tsx')

    expect(panel).toContain('id: "live-compact"')
    expect(panel).toContain('label: "Live Compact"')
    expect(panel).toContain('LIVE_COMPACT_TAB')
    expect(panel).toContain('case "live-compact":')
    expect(panel).toContain('<LiveCompactSettings />')
  })

  test('Given 设置页 When 检查 Then 主闸经既有 settings 更新通道落盘并声明硬停语义', () => {
    const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')

    expect(settings).toContain('window.electronAPI.updateSettings({ liveCompact: { enabled } })')
    expect(settings).toContain('appSettings.liveCompact ?? DEFAULT_SETTINGS')
    // 主闸文案必须说清「关闭即停所有会话、开启后会话默认启用」。
    expect(settings).toContain('关闭会立即停止所有会话')
    expect(settings).toContain('缺省关闭')
  })

  test('Given 设置页 When 检查 Then 展示版本状态、同步按钮与风险提示', () => {
    const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')

    expect(settings).toContain('内置版本')
    expect(settings).toContain('当前生效')
    expect(settings).toContain('上游最新')
    expect(settings).toContain('检查上游')
    expect(settings).toContain('同步上游')
    expect(settings).toContain('回退内置版本')
    expect(settings).toContain('三重校验')
    expect(settings).toContain('spine_recall')
  })
})
