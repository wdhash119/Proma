import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const appShellDirectory = join(rendererRoot, 'components/app-shell')

describe('侧栏「新建任务」防压缩布局', () => {
  test('Given 侧栏最窄档 When 检查 Then 拖拽下限与展开态 minWidth 都是 260', () => {
    const shell = readFileSync(join(appShellDirectory, 'AppShell.tsx'), 'utf8')
    const sidebar = readFileSync(join(appShellDirectory, 'LeftSidebar.tsx'), 'utf8')

    expect(shell).toContain('const MIN_LEFT_SIDEBAR_WIDTH = 260')
    expect(sidebar).toContain('minWidth: 260')
  })

  test('Given 新建任务按钮 When 检查 Then 文字不折行且内联键帽按宽度条件渲染', () => {
    const sidebar = readFileSync(join(appShellDirectory, 'LeftSidebar.tsx'), 'utf8')

    expect(sidebar).toContain('<span className="whitespace-nowrap">新建任务</span>')
    expect(sidebar).toContain('(width ?? 300) >= 280 &&')
  })

  test('Given 非 macOS 侧栏 When 检查 Then 顶部不预留拖拽空白，操作行顶着标题栏', () => {
    const sidebar = readFileSync(join(appShellDirectory, 'LeftSidebar.tsx'), 'utf8')

    // 旧的平台三元留白已移除，拖拽条与红绿灯避让仅 macOS 渲染
    expect(sidebar).not.toContain("isMac ? 'h-[30px]' : 'h-1'")
    expect(sidebar).not.toContain('isMac ? "h-[50px]" : "h-2"')
    expect(sidebar).toContain('SIDEBAR_DRAG_STRIP_HEIGHT.expandedMac')
    expect(sidebar).toContain("isMac && 'pt-3'")
  })
})
