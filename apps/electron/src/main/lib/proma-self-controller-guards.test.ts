import { describe, expect, test } from 'bun:test'
import { BrowserOperationAbortedError } from './browser-cdp'
import { PromaSelfController } from './proma-self-controller'

/**
 * 用假 WebContents/debugger 驱动控制器真实调用链。
 *
 * 这些用例覆盖跨会话串行、批准后重取节点、CDP 恢复超时与长文本取样；
 * 它们不依赖 Electron 进程，可在 Bun 里稳定复现竞态。
 */

interface CdpCall {
  method: string
  params: Record<string, unknown> | undefined
}

type CdpHandler = (method: string, params: Record<string, unknown> | undefined) => unknown

class FakeDebugger {
  attached = false
  calls: CdpCall[] = []
  handler: CdpHandler = () => ({})

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  on(): void {
    // 控制器只登记 detach 监听；测试里不触发。
  }

  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    return Promise.resolve().then(() => this.handler(method, params))
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length
  }
}

function createFakeWindow(debuggerApi: FakeDebugger): Electron.BrowserWindow {
  const contents = {
    isDestroyed: () => false,
    getURL: () => 'https://proma.test/self-control',
    debugger: debuggerApi,
  }
  return {
    isDestroyed: () => false,
    getTitle: () => 'Proma 测试窗口',
    webContents: contents,
  } as unknown as Electron.BrowserWindow
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BUTTON_NODE = {
  backendDOMNodeId: 42,
  role: { value: 'button' },
  name: { value: '创建项目' },
}

describe('跨会话共享 WebContents 串行', () => {
  test('Given 两个前台会话并发 When 一个会话长等待 Then 另一会话的观察排在其后', async () => {
    const debuggerApi = new FakeDebugger()
    const events: string[] = []
    debuggerApi.handler = (method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        events.push('observe')
        return { nodes: [] }
      }
      if (method === 'Runtime.evaluate') {
        const expression = typeof params?.expression === 'string' ? params.expression : ''
        // 等待条件表达式同样引用 innerText，先按 condition.kind 归类，避免误记为取样。
        if (expression.includes('condition.kind')) return { result: { value: false } }
        if (expression.includes('document.body?.innerText')) {
          events.push('sample')
          return { result: { value: { text: '页面内容', title: '' } } }
        }
        return { result: { value: false } }
      }
      return {}
    }
    const sharedWindow = createFakeWindow(debuggerApi)
    const controller = new PromaSelfController(() => sharedWindow)

    const waiting = controller.waitFor('session-a', { kind: 'text', value: '永不出现' }, 300)
    await sleep(20)
    const observing = controller.observe('session-b', 20)

    const [, snapshot] = await Promise.all([waiting, observing])
    expect(snapshot.generation).toBeGreaterThan(0)
    // 会话 A 的取样必须先完成，之后才轮到会话 B 的观察；交错执行会得到 ['observe', 'sample']。
    expect(events).toEqual(['sample', 'observe'])
  })
})

describe('批准创建项目后的点击', () => {
  test('Given 用户批准且回答作废 ref When 继续点击 Then 按身份重取节点并点击成功', async () => {
    const debuggerApi = new FakeDebugger()
    const events: string[] = []
    debuggerApi.handler = (method, params) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [BUTTON_NODE] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-42' } }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { protected: false, projectCreation: false } } }
      }
      if (method === 'Accessibility.getPartialAXTree') {
        return { nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: '创建项目' } }] }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42 }
      if (method === 'Input.dispatchMouseEvent') {
        events.push(String((params as { type?: string } | undefined)?.type ?? ''))
        return {}
      }
      return {}
    }
    const controller = new PromaSelfController(() => createFakeWindow(debuggerApi))
    const snapshot = await controller.observe('session-a', 20)
    const target = snapshot.elements.find((element) => element.name === '创建项目')
    expect(target).toBeDefined()

    let approvalCount = 0
    const result = await controller.click('session-a', target!.ref, undefined, async () => {
      approvalCount += 1
      // 模拟 IPC 在用户回答 AskUser 时无条件作废本会话 ref。
      controller.invalidateSessionRefs('session-a')
      return true
    })

    expect(approvalCount).toBe(1)
    expect(result.label).toContain('创建项目')
    expect(events).toEqual(['mousePressed', 'mouseReleased'])
  })

  test('Given 批准后目标被替换成同位置的其他控件 When 继续点击 Then 拒绝误点并要求重新观察', async () => {
    const debuggerApi = new FakeDebugger()
    let approved = false
    debuggerApi.handler = (method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [BUTTON_NODE] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-42' } }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { protected: false, projectCreation: false } } }
      }
      if (method === 'Accessibility.getPartialAXTree') {
        return {
          nodes: [{
            backendDOMNodeId: 42,
            role: { value: 'button' },
            name: { value: approved ? '删除项目' : '创建项目' },
          }],
        }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42 }
      return {}
    }
    const controller = new PromaSelfController(() => createFakeWindow(debuggerApi))
    const snapshot = await controller.observe('session-a', 20)
    const target = snapshot.elements.find((element) => element.name === '创建项目')
    expect(target).toBeDefined()

    let message = ''
    try {
      await controller.click('session-a', target!.ref, undefined, async () => {
        approved = true
        controller.invalidateSessionRefs('session-a')
        return true
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('已变化')
    expect(message).toContain('重新调用 PromaObserve')
    expect(debuggerApi.count('Input.dispatchMouseEvent')).toBe(0)
  })

  test('Given 批准后目标节点消失 When 继续点击 Then 明确报错且不点击', async () => {
    const debuggerApi = new FakeDebugger()
    let approved = false
    let resolveCalls = 0
    debuggerApi.handler = (method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [BUTTON_NODE] }
      if (method === 'DOM.resolveNode') {
        resolveCalls += 1
        // 批准前的 assertRefAllowed 仍可解析；批准后重取时必须失败。
        if (approved && resolveCalls > 1) throw new Error('No node with given id found')
        return { object: { objectId: 'node-42' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { protected: false, projectCreation: false } } }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      return {}
    }
    const controller = new PromaSelfController(() => createFakeWindow(debuggerApi))
    const snapshot = await controller.observe('session-a', 20)
    const target = snapshot.elements.find((element) => element.name === '创建项目')
    expect(target).toBeDefined()

    let message = ''
    try {
      await controller.click('session-a', target!.ref, undefined, async () => {
        approved = true
        controller.invalidateSessionRefs('session-a')
        return true
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('已不存在')
    expect(message).toContain('重新调用 PromaObserve')
    expect(debuggerApi.count('Input.dispatchMouseEvent')).toBe(0)
  })
})

describe('CDP 自动恢复超时', () => {
  test('Given 文档树恢复命令挂起 When 操作被中止 Then 不会永久堵住队列', async () => {
    const debuggerApi = new FakeDebugger()
    let axCalls = 0
    debuggerApi.handler = (method) => {
      if (method === 'Accessibility.getFullAXTree') {
        axCalls += 1
        if (axCalls === 1) throw new Error('Document needs to be requested first')
        return { nodes: [] }
      }
      if (method === 'DOM.getDocument') {
        // 模拟 CDP 通道卡死：永不 settle。
        return new Promise(() => {})
      }
      return {}
    }
    const controller = new PromaSelfController(() => createFakeWindow(debuggerApi))
    const abort = new AbortController()
    const observe = controller.observe('session-a', 20, abort.signal)
    await sleep(40)
    abort.abort()

    let error: unknown = null
    try {
      await observe
    } catch (caught) {
      error = caught
    }
    expect(error instanceof BrowserOperationAbortedError).toBe(true)
    expect(debuggerApi.count('DOM.getDocument')).toBe(1)
  })
})

describe('长文本等待超时取样', () => {
  test('Given 页面文本超过脚本结果上限 When 等待超时 Then 不误报没有可见文本', async () => {
    const debuggerApi = new FakeDebugger()
    const longText = `设置 外观 主题 ${'长'.repeat(70_000)}`
    debuggerApi.handler = (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = typeof params?.expression === 'string' ? params.expression : ''
        if (expression.includes('document.body?.innerText')) {
          return { result: { value: { text: longText, title: '长页面' } } }
        }
        return { result: { value: false } }
      }
      return {}
    }
    const controller = new PromaSelfController(() => createFakeWindow(debuggerApi))

    const result = await controller.waitFor('session-a', { kind: 'text', value: '不会出现' }, 250)

    expect(result.matched).toBe(false)
    expect(result.message).toBeDefined()
    expect(result.message).not.toContain('当前页面没有可见文本')
    expect(result.message).toContain('重')
    expect(result.visibleText).toBeTruthy()
    expect(result.visibleText!.length).toBeGreaterThan(0)
  })
})
