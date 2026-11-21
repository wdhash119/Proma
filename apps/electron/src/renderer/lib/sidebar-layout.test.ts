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
})
