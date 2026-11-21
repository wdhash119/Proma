import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')

/** 递归收集 renderer 下的全部源码文件。 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('剪贴板写入契约', () => {
  test('Given 渲染端 When 写入剪贴板 Then 一律走统一封装', () => {
    // 直接调用 navigator.clipboard.writeText 会在 Windows 上受 renderer 权限影响，
    // 且无法回退到主进程；统一走 lib/clipboard.ts 的 copyTextToClipboard。
    const offenders = collectSourceFiles(rendererRoot)
      .filter((file) => !file.endsWith(join('lib', 'clipboard.ts')))
      .filter((file) => readFileSync(file, 'utf8').includes('navigator.clipboard.writeText'))
      .map((file) => file.slice(rendererRoot.length + 1))

    expect(offenders).toEqual([])
  })

  test('Given 统一封装 When 检查 Then 主进程优先且保留 reader 兜底', () => {
    const source = readFileSync(join(rendererRoot, 'lib/clipboard.ts'), 'utf8')

    // 主进程写入优先，失败才退回 renderer。
    expect(source).toContain('window.electronAPI?.writeClipboardText')
    expect(source).toContain('navigator.clipboard?.writeText')
    expect(source).toContain('copyTextToClipboard')
  })

  test('Given Vault 草稿复制 When 检查 Then 使用统一封装', () => {
    const vault = readFileSync(join(rendererRoot, 'components/vault/VaultView.tsx'), 'utf8')

    expect(vault).toContain(`from '@/lib/clipboard'`)
    expect(vault).toContain('await copyTextToClipboard(draft)')
  })
})
