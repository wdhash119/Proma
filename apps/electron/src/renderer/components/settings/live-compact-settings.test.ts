import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettingsTab } from '../../atoms/settings-tab'

const appRoot = join(import.meta.dir, '../../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

const SETTINGS_PAGE = 'src/renderer/components/settings/LiveCompactSettings.tsx'
const SEGMENTED_CONTROL = 'src/renderer/components/settings/primitives/SettingsSegmentedControl.tsx'

/** 按起止标记切出源码片段，避免整页断言互相串味。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
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

  test('Given 页头 When 检查 Then 只有标题 + 一个问题号，工作原理浓缩进 tooltip', () => {
    const settings = readAppFile(SETTINGS_PAGE)

    expect(settings).toContain('<h2 className="text-xl font-semibold tracking-tight">Live Compact</h2>')
    expect(settings).toContain('label="Live Compact 工作原理"')
    // 浓缩版原理必须仍然说清“就地压卡 / 不调模型 / 不额外花 token / 原文可取回”。
    expect(settings).toContain('不调用模型、不额外消耗 token')
    expect(settings).toContain('spine_recall')
  })

  test('Given 页头标题 When 检查开关文案 Then 开关叫「总开关」，不再与标题重复', () => {
    const settings = readAppFile(SETTINGS_PAGE)

    // 页头只有一个 Live Compact 标题，开关不再叫 Live Compact。
    expect(settings.split('Live Compact</h2>').length - 1).toBe(1)
    expect(settings).not.toContain('label="Live Compact"')
    expect(settings).toContain('label="总开关"')
    // 主闸问号仍保留「缺省关闭 / 硬停所有会话 / 工具栏可单独关」的语义。
    expect(settings).toContain('helpLabel="全局主闸说明"')
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
    const toggleRowIndex = settings.indexOf('label="总开关"')
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

  test('Given 开关行 When 检查 Then 去掉卡片外壳，两个开关同一 flex 行且保护格随主闸条件渲染', () => {
    const toggleRow = sliceBetween(settings, '{/* 开关行', '{/* 阈值设置')

    // 不再套 SettingsCard：开关行直接落在页面内容里，水平对齐由页面容器内边距提供。
    expect(toggleRow).not.toContain('SettingsCard')
    expect(toggleRow).toContain('flex flex-wrap items-center gap-x-8')
    expect(toggleRow).toContain('label="总开关"')
    expect(toggleRow).toContain('label="结束轮保护"')

    // enabled=false 时保护开关整格不渲染（不是只 disabled）。
    expect(toggleRow).toContain('{settings.enabled && (')
    const protectGuard = toggleRow.slice(toggleRow.indexOf('{settings.enabled && ('))
    expect(protectGuard).toContain('label="结束轮保护"')
    expect(protectGuard).toContain('onCheckedChange={(checked) => void updateProtectCurrentTurn(checked)}')
    // 主闸格在条件块之外，始终可见。
    expect(toggleRow.indexOf('label="总开关"')).toBeLessThan(toggleRow.indexOf('{settings.enabled && ('))

    // 一格内部：标签 + 问号 + Switch 同一行。
    const inlineCell = sliceBetween(settings, 'function ToggleInline', 'export function LiveCompactSettings')
    expect(inlineCell).toContain('flex items-center gap-2')
    expect(inlineCell).toContain('<SettingsHelpTip')
    expect(inlineCell).toContain('<Switch')
    expect(inlineCell).not.toContain('justify-between')
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

  test('Given 主闸关闭 When 检查 Then 阈值设置整节条件渲染，草稿状态留在父组件不被卸载重置', () => {
    const sectionIndex = settings.indexOf('title="阈值设置"')
    const guardIndex = settings.lastIndexOf('{settings.enabled && (', sectionIndex)

    expect(guardIndex).toBeGreaterThan(-1)
    // 条件表达式直接包住 SettingsSection 本身：关掉主闸后整节连同输入框一起卸载。
    expect(settings.slice(guardIndex + '{settings.enabled && ('.length, sectionIndex).trim())
      .toBe('<SettingsSection')

    // 草稿与生效档位的 state 全部声明在 LiveCompactSettings 里，不在被卸载的子树中，
    // 因此重新开启主闸后取值来源、比例/绝对值档位与未保存输入都还在。
    const componentBody = settings.slice(
      settings.indexOf('export function LiveCompactSettings'),
      settings.indexOf('return (\n    <div className="w-full space-y-8">'),
    )
    for (const stateSetter of [
      'setSource',
      'setCustomMode',
      'setRatioDraft',
      'setAbsoluteDraft',
      'setPreviewWindowDraft',
    ]) {
      expect(componentBody).toContain(stateSetter)
    }
    expect(settings).toContain('阈值设置：主开关关闭时整节不渲染；草稿状态在父组件里，重新开启后原样恢复')
  })

  test('Given 卡顶 When 检查 Then 两个无标签分段控件并排，不再有「取值来源」标签', () => {
    const topRow = sliceBetween(settings, '{/* 顶行', '{isCustom ? (')

    expect(topRow).not.toContain('label="取值来源"')
    // 整个页面的分段控件都不再传 label（「取值来源」这个词只留在代码注释里）。
    expect(settings).not.toContain('label="取值来源"')
    expect((settings.match(/<SettingsSegmentedControl/g) ?? []).length).toBe(2)
    // 两个分段控件都不再传 label（只有行尾问号自带 aria-label）：按钮文案已经自解释。
    const controlTags = topRow.split('<SettingsSegmentedControl').slice(1)
    expect(controlTags.length).toBe(2)
    for (const tag of controlTags) {
      expect(tag.slice(0, tag.indexOf('/>'))).not.toContain('label')
    }
    expect(topRow).toContain('options={SOURCE_OPTIONS}')
    expect(topRow).toContain('options={CUSTOM_MODE_OPTIONS}')
    expect(topRow).toContain('flex items-center gap-2')
    // 行尾一个问题号，内容沿用原算法说明（选段旋钮 + 模块加载期求值）。
    expect(topRow).toContain('ml-auto')
    expect(topRow).toContain('content={ORIGIN_COLUMN_HELP}')
    expect(topRow.indexOf('ml-auto')).toBeGreaterThan(topRow.indexOf('options={CUSTOM_MODE_OPTIONS}'))
    expect(settings).toContain('单段最小 1000 / 单段最大 32000 / 指针化 32000 / 保留轮数 3 / 冷却窗 0ms')
    expect(settings).toContain('运行期再改无效')
  })

  test('Given 原算法生效 When 检查 Then 比例/绝对值分段不渲染，切来源仍只发 lineMode', () => {
    const topRow = sliceBetween(settings, '{/* 顶行', '{isCustom ? (')
    const modeGuard = topRow.slice(
      topRow.indexOf('{isCustom && ('),
      topRow.indexOf('options={CUSTOM_MODE_OPTIONS}'),
    )

    expect(modeGuard).toContain('<SettingsSegmentedControl')
    expect(modeGuard).toContain('value={customMode}')
    expect(modeGuard).not.toContain('options={SOURCE_OPTIONS}')

    // origin 只发 lineMode，其它字段由主进程合并磁盘现值。
    expect(settings).toContain('window.electronAPI.updateSettings({ liveCompact: { lineMode: nextMode } })')
    expect(settings).toContain("next === 'origin' ? 'origin' : customMode")
    expect(settings).toContain("label: '比例'")
    expect(settings).toContain("label: '绝对值'")
    // radio 语义用既有分段控件实现，不引入新的 Radix 包。
    expect(settings).not.toContain('react-radio-group')
  })

  test('Given 两列列头 When 检查 Then 不再重复渲染 原算法/自定义 两个列头 span', () => {
    expect(settings).not.toContain('text-sm font-medium text-foreground">原算法')
    expect(settings).not.toContain('text-sm font-medium text-foreground">自定义')
    // 两个分段控件都在卡顶同一行，列头里不再内嵌任何分段控件。
    expect(settings.indexOf('options={SOURCE_OPTIONS}'))
      .toBeLessThan(settings.indexOf('options={CUSTOM_MODE_OPTIONS}'))
  })

  test('Given 自定义主体 When 检查 Then 单一 grid 里四条线逐行成对渲染（同一 fragment 左右 cell）', () => {
    const customBody = sliceBetween(settings, '/* 主体（自定义）', '/* 主体（原算法）')

    expect(customBody).toContain('grid border-t border-border/25 md:grid-cols-2')
    expect(customBody).toContain('THRESHOLD_LINES.map((line, index) =>')

    const row = sliceBetween(customBody, '<React.Fragment key={line.key}>', '</React.Fragment>')
    // 同一 fragment 内左 cell（Origin 只读）与右 cell（可编辑）成对出现。
    expect(row).toContain('describeOriginRow(line.origin)')
    expect(row).toContain('LINE_HELP[line.key][customMode]')
    // 两列同 padding、同高控件（h-8）、宽度相等：行与行天然对齐。
    expect((row.match(/px-4 py-2/g) ?? []).length).toBe(2)
    expect(row).toContain('ReadonlyValue')
    expect((row.match(/className="h-8 /g) ?? []).length).toBe(2)
    // 右列与左列之间的竖分隔。
    expect(row).toContain('md:border-l')
    // 自定义生效时左列整体 dim。
    expect(row).toContain('opacity-55')
    // 窄屏堆叠时右 cell 仍有上分隔线，桌面端去掉避免与 grid 顶线重叠。
    expect(row).toContain('index === 0 && \'md:border-t-0\'')
  })

  test('Given 四条线之后 When 检查 Then 仅右列追加参考窗口行与保存行，左列留空占位', () => {
    const customBody = sliceBetween(settings, '/* 主体（自定义）', '/* 主体（原算法）')
    const tail = customBody.slice(customBody.indexOf('{/* 参考上下文长度'))

    // 左列空占位保持 grid 行结构（窄屏隐藏，避免多出空行）。
    expect(tail).toContain('aria-hidden="true"')
    expect(tail).toContain('hidden border-t border-border/25 md:block')
    expect((tail.match(/aria-hidden="true"/g) ?? []).length).toBe(2)

    expect(tail).toContain('参考上下文长度')
    expect(tail).toContain('PREVIEW_WINDOW_DEFAULT')
    expect(tail).toContain('previewWindowDraft')
    expect(tail).toContain('previewWindow.error')
    // 校验仍复用模型的纯函数。
    expect(settings).toContain('parsePreviewWindow(previewWindowDraft)')
    expect(settings).toContain('不是保存值')

    // 底行：文案在按钮左侧，按钮靠右。
    const saveRow = tail.slice(tail.indexOf('justify-end'))
    expect(saveRow).toContain('保存后下一条消息生效')
    expect(saveRow.indexOf('保存后下一条消息生效')).toBeLessThan(saveRow.indexOf('saveLines()'))
    expect(saveRow).toContain('恢复默认值')
  })

  test('Given 右列自定义 When 检查 Then 比例/绝对值输入并排，非生效框 readOnly+disabled 且显示换算预览', () => {
    const customBody = sliceBetween(settings, '/* 主体（自定义）', '/* 主体（原算法）')

    expect(customBody).toContain('ratioActive ? ratioDraft[line.key] : conversionText(line.key)')
    expect(customBody).toContain('ratioActive ? conversionText(line.key) : absoluteDraft[line.key]')
    expect(customBody).toContain('readOnly={!ratioActive}')
    expect(customBody).toContain('readOnly={ratioActive}')
    expect(customBody).toContain('disabled={loading || !ratioActive}')
    expect(customBody).toContain('disabled={loading || ratioActive}')
    // 切换比例/绝对值分段时，可编辑那一列读回各自草稿（不是把另一列的值搬过来）。
    expect(settings).toContain("customMode === 'ratio' ? ratioDraft : absoluteDraft")
    expect(settings).toContain('calculateConversionPreview')
  })

  test('Given 原算法生效 When 检查 Then 改单列全宽只读行，不渲染 grid/输入框/保存行', () => {
    const originBody = sliceBetween(settings, '/* 主体（原算法）', '</SettingsCard>')

    expect(originBody).toContain('divide-y divide-border/25 border-t border-border/25')
    expect(originBody).toContain('describeOriginRow(line.origin)')
    expect(originBody).toContain('formatTokenCount(line.origin.value)')
    expect(originBody).toContain('ReadonlyValue')
    expect(originBody).not.toContain('<Input')
    expect(originBody).not.toContain('onChange')
    expect(originBody).not.toContain('md:grid-cols-2')
    expect(originBody).not.toContain('opacity-55')
    expect(originBody).not.toContain('保存后下一条消息生效')
  })

  test('Given 保存与恢复默认 When 检查 Then 非法禁用、Enter 仍保存、恢复只重置生效组草稿', () => {
    expect(settings).toContain('disabled={loading || lineSaving || !validation.ok}')
    expect(settings).toContain('恢复默认值')
    expect(settings).toContain('disabled={loading || lineSaving}')
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
    expect(settings).toContain('保存后下一条消息生效')
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

describe('SettingsSegmentedControl：标签可选', () => {
  const segmented = readAppFile(SEGMENTED_CONTROL)

  test('Given 分段控件 When 检查 props Then label 可选，缺省时不渲染标签行', () => {
    expect(segmented).toContain('label?: React.ReactNode')
    expect(segmented).toContain('{(label || description) && (')
    expect(segmented).toContain('{label && <div className={LABEL_CLASS}>{label}</div>}')
    // 按钮组本身保持不变：既有调用方的 label/description 仍会渲染。
    expect(segmented).toContain('value === option.value')
    expect(segmented).toContain('disabled={disabled}')
  })

  test('Given 既有调用方 When 检查 Then 仍显式传 label，行为不受可选化影响', () => {
    const appearance = readAppFile('src/renderer/components/settings/AppearanceSettings.tsx')

    expect(appearance).toContain('label="主题模式"')
    expect(appearance).toContain('label="Markdown 字号"')
  })
})
