import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..')
const appRoot = join(rendererRoot, '../..')
const repoRoot = join(appRoot, '../..')
const diffDirectory = join(rendererRoot, 'components/diff')

/** 递归收集 TypeScript 源码，跳过依赖与构建产物目录 */
function collectSourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, collected)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      collected.push(fullPath)
    }
  }
  return collected
}

describe('Diff 富文本编辑器死岛退役', () => {
  test('Given diff 目录 When 检查 Then 四个富文本编辑器文件已删除', () => {
    for (const removed of [
      'markdown-preview-extensions.tsx',
      'MarkdownEditorToolbar.tsx',
      'MarkdownRichEditor.tsx',
      'TableBubbleMenu.tsx',
    ]) {
      expect(existsSync(join(diffDirectory, removed))).toBe(false)
    }
  })

  test('Given 存活 diff 视图 When 检查 Then 预览与改动列表不受影响', () => {
    for (const kept of ['DiffTabContent.tsx', 'DiffView.tsx', 'DiffChangesList.tsx', 'PreviewPanel.tsx']) {
      expect(existsSync(join(diffDirectory, kept))).toBe(true)
    }
  })

  test('Given 全仓源码 When 检查 Then 没有任何文件再引用富文本编辑器', () => {
    // 标识符动态拼接：避免本测试文件自身命中断言字符串。
    const editorIdentifier = ['Markdown', 'RichEditor'].join('')
    const sources = [
      ...collectSourceFiles(join(appRoot, 'src')),
      ...collectSourceFiles(join(repoRoot, 'packages')),
    ]

    expect(sources.length).toBeGreaterThan(100)
    const offenders = sources
      .filter((file) => file !== import.meta.path)
      .filter((file) => readFileSync(file, 'utf8').includes(editorIdentifier))
    expect(offenders).toEqual([])
  })

  test('Given 桌面应用依赖 When 检查 Then 死岛依赖已移除且 tiptap 核心保留', () => {
    const manifest = readFileSync(join(appRoot, 'package.json'), 'utf8')

    for (const removed of [
      'tiptap-markdown',
      '@tiptap/extension-table"',
      '@tiptap/extension-table-cell',
      '@tiptap/extension-table-header',
      '@tiptap/extension-table-row',
      '@tiptap/extension-task-item',
      '@tiptap/extension-task-list',
      'cmdk',
      'chokidar',
      'rehype-raw',
      // 末尾带引号＝完整键名匹配，避免命中同前缀的其它包。
      '@radix-ui/react-toast"',
    ]) {
      expect(manifest).not.toContain(`"${removed}`)
    }

    // @tiptap/react 是仍在使用的富文本输入依赖，其 peer 核心包不能被连带删除。
    expect(manifest).toContain('"@tiptap/core":')
    expect(manifest).toContain('"@tiptap/pm":')
    expect(manifest).toContain('"@tiptap/react":')
  })
})