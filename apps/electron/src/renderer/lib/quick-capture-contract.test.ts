import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('清单快速捕获', () => {
  test('Given 快捷键定义 When 检查 Then 存在全局 quick-capture 且默认 Ctrl/Cmd+Shift+T', () => {
    const defaults = readAppFile('src/renderer/lib/shortcut-defaults.ts')

    expect(defaults).toContain("id: 'quick-capture'")
    expect(defaults).toContain("defaultMac: 'Cmd+Shift+T'")
    expect(defaults).toContain("defaultWin: 'Ctrl+Shift+T'")
    expect(defaults).toContain("category: 'global'")
  })

  test('Given 主进程 When 检查 Then 注册全局快捷键并转发打开事件', () => {
    const mainIndex = readAppFile('src/main/index.ts')
    const shortcutService = readAppFile('src/main/lib/global-shortcut-service.ts')

    expect(shortcutService).toContain("'quick-capture'")
    expect(mainIndex).toContain("registerGlobalShortcut('quick-capture'")
    expect(mainIndex).toContain('PLANNING_IPC_CHANNELS.OPEN_QUICK_CAPTURE')
  })

  test('Given 渲染进程 When 检查 Then 快捷键与 IPC 都打开清单新建入口', () => {
    const shortcuts = readAppFile('src/renderer/components/shortcuts/GlobalShortcuts.tsx')

    // 应用内回退与全局 IPC 走同一条路径：切到清单视图并触发新建。
    expect(shortcuts).toContain("setActiveView('planning')")
    expect(shortcuts).toContain('setTodoCreateRequest((value) => value + 1)')
    expect(shortcuts).toContain('onOpenPlanningQuickCapture')
  })

  test('Given preload When 检查 Then 暴露快速捕获监听', () => {
    const preload = readAppFile('src/preload/index.ts')

    expect(preload).toContain('onOpenPlanningQuickCapture')
    expect(preload).toContain('PLANNING_IPC_CHANNELS.OPEN_QUICK_CAPTURE')
  })
})
