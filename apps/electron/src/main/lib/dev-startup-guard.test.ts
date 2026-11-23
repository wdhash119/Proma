import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 首次 dev 启动循环的回归守卫：
 * 1. build:resources 必须先建好 dist/ 再复制资源，否则新 worktree 里 cp 静默失败，
 *    dist/resources/startup-splash 缺失，启动页加载必然报错；
 * 2. 启动页加载失败不能销毁当时唯一的窗口，否则非 macOS 会立刻 window-all-closed
 *    → app.quit()，主窗口尚未创建，electronmon 陷入重启循环。
 */
const appRoot = join(import.meta.dir, '../../..')
const mainIndexPath = join(import.meta.dir, '../index.ts')

function readElectronFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

interface ElectronPackageManifest {
  scripts?: Record<string, string>
}

describe('dev 启动资源准备', () => {
  test('Given build:resources When 检查脚本 Then 先 mkdir -p dist 再 cp，且不再静默吞错', () => {
    const manifest = JSON.parse(readElectronFile('package.json')) as ElectronPackageManifest
    const script = manifest.scripts?.['build:resources'] ?? ''

    const mkdirAt = script.indexOf('mkdir -p dist')
    const copyAt = script.indexOf('cp -R resources dist/')

    expect(mkdirAt).toBeGreaterThanOrEqual(0)
    expect(copyAt).toBeGreaterThan(mkdirAt)
    // Bun shell 的内建 cp 只接受 -R；-r 会报 illegal option 并静默失败。
    expect(script).not.toContain('cp -r ')
    // `2>/dev/null || true` 会把复制失败藏起来，正是本次启动循环的成因。
    expect(script).not.toContain('2>/dev/null')
    expect(script).not.toContain('|| true')
  })
})

describe('启动页失败竞态', () => {
  test('Given 启动页加载失败 When 检查 catch Then 只隐藏窗口并保留实例，不销毁唯一窗口', () => {
    const source = readFileSync(mainIndexPath, 'utf8')
    const startAt = source.indexOf('function createStartupSplashWindow()')
    const endAt = source.indexOf('/** 获取主窗口实例', startAt)

    expect(startAt).toBeGreaterThanOrEqual(0)
    expect(endAt).toBeGreaterThan(startAt)

    const splashFactory = source.slice(startAt, endAt)

    expect(splashFactory).toContain('splash.hide()')
    // 直接清理会让「启动页是唯一窗口」时触发 window-all-closed → app.quit()。
    expect(splashFactory).not.toContain('dismissStartupSplash')
    expect(splashFactory).not.toContain('startupSplashWindow.destroy()')
  })

  test('Given 主窗口或降级窗口就绪 When 检查清理路径 Then 启动页仍由它们统一销毁', () => {
    const source = readFileSync(mainIndexPath, 'utf8')

    // 主窗口首帧合成后销毁启动页，避免冷启动闪屏。
    expect(source).toMatch(/once\('ready-to-show', \(\) => \{[\s\S]{0,400}?dismissStartupSplash\(\)/)
    // 主窗口创建本身也失败时，兜底销毁启动页，避免留下不可见也无法关闭的窗口。
    expect(source).toMatch(/catch \(fallbackErr\) \{[\s\S]{0,400}?dismissStartupSplash\(\)/)
    // window-all-closed 的退出语义保持不变，仍是本次竞态的关键前提。
    expect(source).toMatch(/app\.on\('window-all-closed'[\s\S]{0,200}?app\.quit\(\)/)
  })
})
