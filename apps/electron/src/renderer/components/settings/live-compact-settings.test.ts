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
    // 主闸文案必须说清「关闭即停所有会话的上下文改写、开启后会话默认启用且可在工具栏单独关闭」。
    expect(settings).toContain('关闭会立即停止所有会话的上下文改写（包括曾单独开启的会话）')
    expect(settings).toContain('可在会话工具栏单独关闭')
    expect(settings).toContain('缺省关闭')
  })

  test('Given 检查上游无更新 When 提示 Then 文案是“已是上游最新版本”', () => {
    const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')

    expect(settings).toContain("toast.success('当前算法已是上游最新版本')")
    expect(settings).not.toContain('当前算法已对应当前上游版本')
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

describe('Live Compact 设置页：当前轮保护与四条线', () => {
  const settings = readAppFile('src/renderer/components/settings/LiveCompactSettings.tsx')

  test('Given 设置页 When 检查分节顺序 Then 保护与 Advanced 与 Origin 都插在全局开关与工作原理之间', () => {
    const globalIndex = settings.indexOf('title="全局开关"')
    const protectIndex = settings.indexOf('title="当前轮保护"')
    const advancedIndex = settings.indexOf('title="Advanced：四条线"')
    const originIndex = settings.indexOf('title="Origin（上游原逻辑，只读）"')
    const howIndex = settings.indexOf('title="工作原理"')

    expect(globalIndex).toBeGreaterThan(-1)
    expect(protectIndex).toBeGreaterThan(globalIndex)
    expect(advancedIndex).toBeGreaterThan(protectIndex)
    expect(originIndex).toBeGreaterThan(advancedIndex)
    expect(howIndex).toBeGreaterThan(originIndex)
  })

  test('Given 当前轮保护开关 When 检查 Then 独立开关经 settings 通道落盘且声明保护语义与缺省开', () => {
    expect(settings).toContain('window.electronAPI.updateSettings({')
    expect(settings).toContain('liveCompact: { enabled: settings.enabled, protectCurrentTurn }')
    expect(settings).toContain('保护刚结束的这一轮')
    expect(settings).toContain('刚结束的这一轮')
    expect(settings).toContain('投影尾部永不被压缩')
    expect(settings).toContain('缺省开启')
    // 关闭后的上游行为必须写明，含历史上的静默截断后果。
    expect(settings).toContain('也可能被切成卡片')
    expect(settings).toContain('静默截断')
    // 保护开关取值必须与主进程一致：只有显式 false 才算关。
    expect(settings).toContain("settings.protectCurrentTurn !== false")
  })

  test('Given Advanced When 检查 Then 有比例/绝对值分段控件、四条线输入与显式保存按钮', () => {
    expect(settings).toContain('比例（按模型窗口）')
    expect(settings).toContain('绝对值（token）')
    // 四条线的中文名与顺序在纯模块里单一来源，页面只负责按 key 渲染。
    expect(settings).toContain('LIVE_COMPACT_LINE_KEYS.map')
    expect(settings).toContain('LIVE_COMPACT_LINE_LABELS[key]')
    expect(settings).toContain('保存四条线')
    // 顺序非法时保存按钮必须被禁用，而不是交给主进程静默回落。
    expect(settings).toContain('disabled={loading || lineSaving || !validation.ok}')
    expect(settings).toContain('liveCompact: { enabled: settings.enabled, ...payload }')
  })

  test('Given 比例模式 When 检查 Then 有试算输入与官方 0.8 对照，且明确不参与保存', () => {
    expect(settings).toContain('试算上下文长度（token）')
    expect(settings).toContain('不参与保存')
    expect(settings).toContain('Pi 官方自动压缩线')
    expect(settings).toContain('calculateLinePreview')
    expect(settings).toContain('PREVIEW_WINDOW_COMPARISON')
    expect(settings).toContain('Math.max(1, Math.round(窗口 × 占比))')
  })

  test('Given Origin 卡 When 检查 Then 用模块行数据只读渲染并给出两条后果说明', () => {
    expect(settings).toContain('LIVE_COMPACT_ORIGIN_LINE_ROWS')
    expect(settings).toContain('LIVE_COMPACT_ORIGIN_KNOB_ROWS')
    expect(settings).toContain('row.envKey')
    expect(settings).toContain('不随窗口变化')
    expect(settings).toContain('等价于云端每轮收尾最多只切一刀')
    expect(settings).toContain('上下文会被一路压到 32000 token')
    expect(settings).toContain('只在要复现上游行为时这样填')
    // 只读：Origin 段内不得出现输入控件或保存入口。
    const originSection = settings.slice(
      settings.indexOf('title="Origin（上游原逻辑，只读）"'),
      settings.indexOf('title="工作原理"'),
    )
    expect(originSection).not.toContain('<SettingsInput')
    expect(originSection).not.toContain('<Button')
  })

  test('Given 四条线与保护 When 检查生效时机文案 Then 是“保存后下一条消息生效”而非“需要新建会话”', () => {
    expect(settings).toContain('下一条消息生效')
    expect(settings).toContain('当前进行中的那一轮不受影响')
    expect(settings).not.toContain('需要新建会话')
  })
})
