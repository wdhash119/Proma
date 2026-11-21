import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('自操作可辨识性契约', () => {
  test('Given 侧栏折叠按钮 When 检查 Then 与展开按钮一样带 aria-label', () => {
    const sidebar = readAppFile('src/renderer/components/app-shell/LeftSidebar.tsx')

    // 两个按钮必须对称命名，否则 AX 树里收起按钮无名，Agent 只能靠位置猜。
    expect(sidebar).toContain('aria-label="收起侧边栏"')
    expect(sidebar).toContain('aria-label="展开侧边栏"')
  })

  test('Given 其它纯图标按钮 When 检查 Then 都带 aria-label', () => {
    const automation = readAppFile('src/renderer/components/automation/AutomationFormView.tsx')
    const attachment = readAppFile('src/renderer/components/chat/AttachmentPreviewItem.tsx')

    expect(automation).toContain('aria-label="关闭定时任务编辑"')
    expect(attachment).toContain('移除附件')
  })

  test('Given 无名元素 When 观察 Then 从 DOM 属性提炼 hint', () => {
    const controller = readAppFile('src/main/lib/proma-self-controller.ts')
    const hint = readAppFile('src/main/lib/proma-self-element-hint.ts')

    // 线索来源：data-testid / aria-label / title / name / id / 语义类名。
    expect(hint).toContain("'data-testid'")
    expect(hint).toContain('buildElementHint')
    // DOM 属性读取需要先请求文档树，否则 CDP 直接报错。
    expect(controller).toContain('DOM.getDocument')
    expect(controller).toContain('DOM.pushNodesByBackendIdsToFrontend')
    expect(controller).toContain('DOM.getAttributes')
    // 无名线索要进 label，避免多个元素都显示成同一个词。
    expect(controller).toContain('candidate.role}[${hint}')
  })

  test('Given 既无名也无线索 When 观察 Then 给出改用 selector 的指引', () => {
    const controller = readAppFile('src/main/lib/proma-self-controller.ts')
    const hint = readAppFile('src/main/lib/proma-self-element-hint.ts')

    expect(controller).toContain('note: describeUnnamedElement(candidate.role)')
    expect(hint).toContain('不要凭顺序猜')
  })

  test('Given 只读任务 When 检查提示词 Then 要求关闭临时界面并禁止顺手改状态', () => {
    const prompt = readAppFile('src/main/lib/agent-prompt-builder.ts')

    expect(prompt).toContain('读完后必须恢复到原状态')
    expect(prompt).toContain('不要读完就停在那里')
    expect(prompt).toContain('只读任务不要顺手改动界面状态')
  })
})
