import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')
const repoRoot = join(appRoot, '../..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('HTML 截图导出链退役', () => {
  test('Given 主进程 When 检查 Then 截图服务文件已删除', () => {
    expect(existsSync(join(repoRoot, 'apps/electron/src/main/lib/screenshot-service.ts'))).toBe(false)
  })

  test('Given preload 桥接层 When 检查 Then 不再暴露 screenshotCapture', () => {
    const preload = readRepoFile('apps/electron/src/preload/index.ts')

    expect(preload).not.toContain('screenshotCapture')
  })

  test('Given 主进程 IPC When 检查 Then 不再注册截图 handler', () => {
    const ipc = readRepoFile('apps/electron/src/main/ipc.ts')

    expect(ipc).not.toContain('SCREENSHOT_CAPTURE')
    expect(ipc).not.toContain('screenshot-service')
  })

  test('Given 共享类型 When 检查 Then 截图通道与配额常量均已移除', () => {
    const runtime = readRepoFile('packages/shared/src/types/runtime.ts')

    expect(runtime).not.toContain('SCREENSHOT_CAPTURE')
    expect(runtime).not.toContain('SCREENSHOT_LIMITS')
  })

  test('Given 应用依赖 When 检查 Then 不再声明 pngjs 与其类型包', () => {
    const packageJson = readRepoFile('apps/electron/package.json')

    expect(packageJson).not.toContain('pngjs')
  })
})