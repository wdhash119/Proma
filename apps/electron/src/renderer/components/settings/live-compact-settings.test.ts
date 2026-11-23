import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettingsTab } from '../../atoms/settings-tab'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

const SETTINGS_PAGE = 'src/renderer/components/settings/LiveCompactSettings.tsx'

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

  test('Given 页头 When 检查 Then 只有标题 + 一个问题号，工作原理浓缩进 tooltip', () => {
    const settings = readAppFile(SETTINGS_PAGE)

    expect(settings).toContain('<h2 className="text-xl font-semibold tracking-tight">Live Compact</h2>')
    expect(settings).toContain('label="Live Compact 工作原理"')
    // 浓缩版原理必须仍然说清“就地压卡 / 不调模型 / 不额外花 token / 原文可取回”。
    expect(settings).toContain('不调用模型、不额外消耗 token')
    expect(settings).toContain('spine_recall')
  })

  test('Given 主闸 When 检查 Then 经既有 settings 更新通道落盘且工具提示声明硬停语义', () => {
    const settings = readAppFile(SETTINGS_PAGE)

    expect(settings).toContain('window.electronAPI.updateSettings({ liveCompact: { enabled } })')
    expect(settings).toContain('appSettings.liveCompact ?? DEFAULT_SETTINGS')
    // 主闸工具提示必须说清「关闭即停所有会话、开启后会话默认启用且可在工具栏单独关闭、缺省关闭」。
    expect(settings).toContain('关闭会立即停止所有会话的上下文改写（包括曾单独开启的会话）')
    expect(settings).toContain('可在会话工具栏单独关闭')
    expect(settings).toContain('缺省关闭')
  })

  test('Given 检查上游无更新 When 提示 Then 文案是“已是上游最新版本”', () => {
    const settings = readAppFile(SETTINGS_PAGE)

    expect(settings).toContain("toast.success('当前算法已是上游最新版本')")
    expect(settings).not.toContain('当前算法已对应当前上游版本')
  })
})

describe('Live Compact 设置页：新布局（开关行 → 阈值设置 → 算法更新）', () => {
  const settings = readAppFile(SETTINGS_PAGE)

  test('Given 设置页 When 检查分节顺序 Then 开关行在阈值设置之前、阈值设置在算法更新之前', () => {
    const toggleRowIndex = settings.indexOf('label="Live Compact"')
    const thresholdIndex = settings.indexOf('title="阈值设置"')
    const updateIndex = settings.indexOf('title="算法更新"')

    expect(toggleRowIndex).toBeGreaterThan(-1)
    expect(thresholdIndex).toBeGreaterThan(toggleRowIndex)
    expect(updateIndex).toBeGreaterThan(thresholdIndex)
  })

  test('Given 重构后 When 检查 Then 旧的 verbose 分节标题全部消失', () => {
    for (const legacy of [
      'title="全局开关"',
      'title="当前轮保护"',
      'title="Advanced：四条线"',
      'title="Origin（上游原逻辑，只读）"',
      'title="工作原理"',
      'title="风险提示"',
    ]) {
      expect(settings).not.toContain(legacy)
    }
  })

  test('Given 开关行 When 检查 Then 主闸与结束轮保护并排在同一张卡里', () => {
    const toggleCard = settings.slice(
      settings.indexOf('<SettingsCard divided={false}>'),
      settings.indexOf('title="阈值设置"'),
    )

    expect(toggleCard).toContain('label="Live Compact"')
    expect(toggleCard).toContain('label="结束轮保护"')
    expect(toggleCard).toContain('md:grid-cols-2')
    // 窄屏堆叠：上下分隔线在小屏生效。
    expect(toggleCard).toContain('divide-y')
  })

  test('Given 结束轮保护 When 检查 Then 独立开关经 settings 通道落盘且工具提示声明保护语义与缺省开', () => {
    expect(settings).toContain('liveCompact: { protectCurrentTurn },')
    expect(settings).toContain('刚结束的这一轮（末条消息与工具结果）与投影尾部永不被切')
    expect(settings).toContain('缺省开启')
    // 关闭后的上游行为必须写明，含历史上的静默截断后果。
    expect(settings).toContain('也可能被切成卡片')
    expect(settings).toContain('静默截断')
    // 保护开关取值必须与主进程一致：只有显式 false 才算关。
    expect(settings).toContain('settings.protectCurrentTurn !== false')
  })
})

describe('Live Compact 设置页：阈值设置', () => {
  const settings = readAppFile(SETTINGS_PAGE)

  test('Given 卡顶 When 检查 Then 用既有分段控件选原算法/自定义，切来源只发 lineMode', () => {
    expect(settings).toContain('label="取值来源"')
    expect(settings).toContain("label: '原算法（上游默认）'")
    expect(settings).toContain("label: '自定义'")
    // origin 只发 lineMode，其它字段由主进程合并磁盘现值。
    expect(settings).toContain('window.electronAPI.updateSettings({ liveCompact: { lineMode: nextMode } })')
    expect(settings).toContain("next === 'origin' ? 'origin' : customMode")
    expect(settings).toContain("label: '比例'")
    expect(settings).toContain("label: '绝对值'")
    // radio 语义用既有分段控件实现，不引入新的 Radix 包。
    expect(settings).not.toContain('react-radio-group')
  })

  test('Given 左列原算法 When 检查 Then 用模块行数据只读渲染，没有任何输入控件', () => {
    const originColumn = settings.slice(
      settings.indexOf('LIVE_COMPACT_ORIGIN_LINE_ROWS.map'),
      settings.indexOf('{/* 右列：自定义'),
    )

    expect(originColumn).toContain('describeOriginRow(row)')
    expect(originColumn).toContain('formatTokenCount(row.value)')
    expect(originColumn).toContain('ReadonlyValue')
    expect(originColumn).not.toContain('<SettingsInput')
    expect(originColumn).not.toContain('<Input')
    // 只读列不绑定任何变更回调。
    expect(originColumn).not.toContain('onChange')
    // 列头问题号必须讲清选段旋钮与“加载期求值、运行期改无效”。
    expect(settings).toContain('单段最小 1000 / 单段最大 32000 / 指针化 32000 / 保留轮数 3 / 冷却窗 0ms')
    expect(settings).toContain('运行期再改无效')
  })

  test('Given 两列生效关系 When 检查 Then 生效列正常、非生效列整体 dim', () => {
    expect(settings).toContain("isCustom && 'opacity-55'")
    expect(settings).toContain("!isCustom && 'opacity-55'")
  })

  test('Given 右列自定义 When 检查 Then 比例/绝对值输入并排，非生效框 readOnly+disabled 且显示换算预览', () => {
    const customColumn = settings.slice(
      settings.indexOf('{/* 右列：自定义'),
      settings.indexOf('{/* 算法更新'),
    )

    expect(customColumn).toContain('ratioActive ? ratioDraft[key] : conversionText(key)')
    expect(customColumn).toContain('ratioActive ? conversionText(key) : absoluteDraft[key]')
    expect(customColumn).toContain('readOnly={!ratioActive}')
    expect(customColumn).toContain('readOnly={ratioActive}')
    expect(customColumn).toContain('disabled={loading || !isCustom || !ratioActive}')
    expect(customColumn).toContain('disabled={loading || !isCustom || ratioActive}')
    // 切换比例/绝对值分段时，可编辑那一列读回各自草稿（不是把另一列的值搬过来）。
    expect(settings).toContain("customMode === 'ratio' ? ratioDraft : absoluteDraft")
  })

  test('Given 换算预览 When 检查 Then 参考上下文长度复用缺省窗口，且明确灰框不是保存值', () => {
    expect(settings).toContain('参考上下文长度')
    expect(settings).toContain('PREVIEW_WINDOW_DEFAULT')
    expect(settings).toContain('calculateConversionPreview')
    expect(settings).toContain('不是保存值')
    expect(settings).toContain('parsePreviewWindow')
  })

  test('Given 保存与恢复默认 When 检查 Then 非法禁用、Enter 仍保存、恢复只重置生效组草稿', () => {
    expect(settings).toContain('disabled={loading || lineSaving || !isCustom || !validation.ok}')
    expect(settings).toContain('恢复默认值')
    expect(settings).toContain('disabled={loading || lineSaving || !isCustom}')
    expect(settings).toContain("event.key === 'Enter'")
    expect(settings).toContain('void saveLines()')
    expect(settings).toContain('ratiosToDraft(RENDERER_DEFAULT_LINE_RATIOS)')
    expect(settings).toContain('absoluteToDraft(RENDERER_DEFAULT_LINE_ABSOLUTE)')
  })

  test('Given 四条线补丁 When 检查 Then 只发 lineMode + 生效组，不包含 enabled', () => {
    expect(settings).toContain("lineMode: 'ratio' as const, ratios: validation.ratios")
    expect(settings).toContain("lineMode: 'absolute' as const, absolute: validation.absolute")
    expect(settings).toContain('liveCompact: payload,')
    expect(settings).not.toContain('liveCompact: { enabled: settings.enabled, ...payload }')

    const protectBody = settings.slice(
      settings.indexOf('const updateProtectCurrentTurn'),
      settings.indexOf('const updateLineSource'),
    )
    const saveBody = settings.slice(
      settings.indexOf('const saveLines'),
      settings.indexOf('/** 恢复默认值'),
    )
    for (const body of [protectBody, saveBody]) {
      expect(body).not.toContain('settings.enabled')
    }
  })

  test('Given 四条线补丁 When 检查主进程合并 Then 省略字段由磁盘现值保留（含全局主闸）', () => {
    const service = readAppFile('src/main/lib/settings-service.ts')

    // 写入侧唯一入口：补丁叠在已落盘设置上再归一化，缺省字段不会被清零。
    expect(service).toContain('normalizeLiveCompactSettings({ ...current, ...patch })')
    expect(service).toContain('liveCompact: mergeLiveCompactSettings(current.liveCompact, updates.liveCompact)')
    // 补丁类型必须真正允许省略字段，否则渲染层的部分更新写法会失去类型保护。
    const types = readAppFile('src/types/settings.ts')
    expect(types).toContain('export type LiveCompactSettingsPatch = Partial<LiveCompactSettings>')
    expect(types).toContain("export type LiveCompactLineMode = 'ratio' | 'absolute' | 'origin'")
  })

  test('Given 四条线与保护 When 检查生效时机文案 Then 是“保存后下一条消息生效”而非“需要新建会话”', () => {
    expect(settings).toContain('下一条消息生效')
    expect(settings).toContain('当前进行中的那一轮不受影响')
    expect(settings).not.toContain('需要新建会话')
  })
})

describe('Live Compact 设置页：算法更新与问号提示原语', () => {
  const settings = readAppFile(SETTINGS_PAGE)

  test('Given 算法更新 When 检查 Then 刷新状态在节头右侧，三行状态与三个按钮齐全', () => {
    const section = settings.slice(settings.indexOf('title="算法更新"'))

    expect(section).toContain('刷新状态')
    expect(section).toContain('action={(')
    expect(section).toContain('内置版本')
    expect(section).toContain('当前生效')
    expect(section).toContain('上游最新')
    expect(section).toContain('检查上游')
    expect(section).toContain('同步上游')
    expect(section).toContain('回退内置版本')
    // 刷新状态是本节头右侧的操作，不是页头按钮。
    expect(section.indexOf('刷新状态')).toBeLessThan(section.indexOf('内置版本'))
    expect(settings).not.toContain('<RefreshCw className={loading ? \'animate-spin\' : undefined} />\n          刷新状态\n        </Button>\n      </div>')
  })

  test('Given 同步与回退 When 检查 Then 三重闸与“只删激活标记”都收进按钮问号', () => {
    expect(settings).toContain('三重闸')
    expect(settings).toContain('只删除激活标记')
    expect(settings).toContain('label="同步上游说明"')
    expect(settings).toContain('label="回退内置版本说明"')
    expect(settings).toContain('上次同步未激活')
    expect(settings).toContain('读取版本状态失败')
  })

  test('Given 全页说明 When 检查 Then 一律走 SettingsHelpTip 问号，不再有大段 description', () => {
    expect(settings).toContain('SettingsHelpTip,')
    expect(settings).toContain('<SettingsHelpTip')
    const tipCount = settings.split('<SettingsHelpTip').length - 1
    expect(tipCount).toBeGreaterThanOrEqual(6)
    // 旧的整段说明段落（页头 description）已删除。
    expect(settings).not.toContain('对话变长时，把已完成的段落就地压成可回溯的卡片，减少上下文占用。')
  })

  test('Given SettingsHelpTip When 检查原语 Then 基于既有 ui/tooltip 与 lucide 图标并已导出', () => {
    const tip = readAppFile('src/renderer/components/settings/primitives/SettingsHelpTip.tsx')

    expect(tip).toContain("from '@/components/ui/tooltip'")
    expect(tip).toContain('TooltipTrigger')
    expect(tip).toContain('TooltipContent')
    expect(tip).toContain('HelpCircle')
    // 键盘可达：问号必须是带 aria-label 的 button。
    expect(tip).toContain('aria-label={label}')

    const primitives = readAppFile('src/renderer/components/settings/primitives/index.ts')
    expect(primitives).toContain("export * from './SettingsHelpTip'")
  })
})
