import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '../../..')

function readAppFile(relativePath: string): string {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('Proma 自操作契约', () => {
  test('Given Pi 工具集 When 检查 Then 注册了十个 Proma* 工具并注入统一入口', () => {
    const tools = readAppFile('src/main/lib/adapters/pi-proma-self-tools.ts')
    const builtin = readAppFile('src/main/lib/adapters/pi-builtin-tools.ts')

    for (const name of [
      'PromaObserve', 'PromaFind', 'PromaClick', 'PromaAct', 'PromaFill',
      'PromaPress', 'PromaDomAction', 'PromaScroll', 'PromaWaitFor', 'PromaScreenshot',
    ]) {
      expect(tools).toContain(`name: '${name}'`)
    }
    expect(builtin).toContain('buildPromaSelfTools(sdk, ctx)')
  })

  test('Given 无可见窗口的来源 When 检查 Then 不注入自操作工具', () => {
    const builtin = readAppFile('src/main/lib/adapters/pi-builtin-tools.ts')

    expect(builtin).toContain('const selfControlAvailable')
    expect(builtin).toContain("ctx.triggeredBy !== 'automation'")
    expect(builtin).toContain("ctx.triggeredBy !== 'delegation'")
    expect(builtin).toContain("ctx.triggeredBy !== 'external'")
  })

  test('Given 控制器 When 检查 Then 通过主窗口 debugger 走 CDP 且限制截图与脚本体积', () => {
    const controller = readAppFile('src/main/lib/proma-self-controller.ts')

    expect(controller).toContain("attach('1.3')")
    expect(controller).toContain('Accessibility.getFullAXTree')
    expect(controller).toContain('Input.dispatchMouseEvent')
    expect(controller).toContain('Input.insertText')
    expect(controller).toContain('MAX_SCREENSHOT_BYTES')
    expect(controller).toContain('MAX_SCRIPT_RESULT_CHARS')
    // 旧 ref 必须立即失效。
    expect(controller).toContain('界面元素引用已失效，请先重新调用 PromaObserve')
  })

  test('Given 创建项目 When 检查 Then 必须先取得用户同意', () => {
    const controller = readAppFile('src/main/lib/proma-self-controller.ts')
    const orchestrator = readAppFile('src/main/lib/agent-orchestrator.ts')

    expect(controller).toContain('requireProjectApproval')
    expect(controller).toContain('PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR')
    // 同意通道复用 AskUserQuestion 卡片。
    expect(orchestrator).toContain('requestPromaSelfApproval')
    expect(orchestrator).toContain('Agent 准备在 Proma 界面里创建项目')
  })

  test('Given DOM 操作 When 检查 Then 带守卫拦截受保护控件', () => {
    const scriptPolicy = readAppFile('src/main/lib/browser-script-policy.ts')
    const controller = readAppFile('src/main/lib/proma-self-controller.ts')

    expect(scriptPolicy).toContain('BrowserDomActionGuard')
    expect(scriptPolicy).toContain('guardConfigRef && isProtectedElement')
    expect(controller).toContain('buildBrowserDomActionExpression(input, guard)')
  })

  test('Given 系统提示词 When 检查 Then 只在可用时注入自操作指引', () => {
    const prompt = readAppFile('src/main/lib/agent-prompt-builder.ts')

    expect(prompt).toContain('selfControlAvailable')
    expect(prompt).toContain('## Proma 自操作')
    expect(prompt).toContain('必须先通过')
  })

  test('Given 生产渲染端 When 检查 Then 编辑器/问答/新建项目已接入安全标记', () => {
    const richTextInput = readAppFile('src/renderer/components/ai-elements/rich-text-input.tsx')
    const askUserBanner = readAppFile('src/renderer/components/agent/AskUserBanner.tsx')
    const leftSidebar = readAppFile('src/renderer/components/app-shell/LeftSidebar.tsx')
    const collapsedWorkspacePopover = readAppFile('src/renderer/components/agent/CollapsedWorkspacePopover.tsx')

    // Agent 与 Chat 共用 RichTextInput，标记放在其根节点即可同时覆盖两条编辑器路径。
    expect(richTextInput).toContain('data-proma-self-control="deny"')
    expect(askUserBanner).toContain('data-proma-self-control="deny"')
    // 「新建空白项目」的提交输入行都必须需要批准；原 WorkspaceSelector 死岛已退役。
    expect(leftSidebar).toContain('data-proma-self-control="create-project"')
    expect(collapsedWorkspacePopover).toContain('data-proma-self-control="create-project"')
  })

  test('Given 会话删除 When 检查 Then 清理自操作引用与在途指令', () => {
    const ipc = readAppFile('src/main/ipc.ts')

    expect(ipc).toContain('promaSelfController.disposeSession(id)')
  })
})
