/**
 * Proma 自操作控制器：通过内部 CDP 通道观察与操作 Proma 自身主窗口。
 *
 * 设计要点：
 * - 只操作主窗口，不触碰受管浏览器（那是 Browser* 工具的职责）；
 * - 每次观察都会更新 generation 并清空 ref，旧 ref 立即失效，
 *   避免 Agent 拿着过期快照乱点；
 * - 所有操作按会话串行排队，同一会话的指令不会互相插入；
 * - 受保护控件与「需要用户同意」的动作在 CDP 层就被拦截（见 proma-self-control-policy）；
 * - 截图与脚本结果都有大小上限，避免把主进程内存打满。
 */

import type { WebContents } from 'electron'
import { getMainWindow } from './main-window-store'
import {
  BROWSER_OBSERVE_TIMEOUT_MS,
  BrowserOperationAbortedError,
  resolveBrowserObserveAxDepth,
  throwIfBrowserOperationAborted,
  withBrowserCdpTimeout,
} from './browser-cdp'
import {
  browserObservationNameLimit,
  prioritizeBrowserObservationCandidates,
  resolveBrowserObserveMaxElements,
} from './browser-observation-policy'
import { parseBrowserPressAction } from './browser-key-policy'
import { buildBrowserDomActionExpression, buildBrowserScrollExpression } from './browser-script-policy'
import type { BrowserDomActionGuard } from './browser-script-policy'
import { cdpAxPropertyBoolean, cdpTextValue, isEditableCdpAxNode, type CdpAxNode } from './cdp-ax'
import { isValidImageBytes } from './image-content-validation'
import {
  PROMA_SELF_CONTROL_PROJECT_CONSENT_DENIED,
  PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR,
  PROMA_SELF_CONTROL_PROTECTED_ERROR,
  createPromaSelfControlDomGuard,
  isPromaSelfControlActionLabelProtected,
  isPromaSelfControlProjectCreationLabel,
} from './proma-self-control-policy'

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024
const MAX_SCRIPT_RESULT_CHARS = 64_000
/** 同意创建项目后 2 分钟内不必重复询问。 */
const PROJECT_CONSENT_TTL_MS = 2 * 60 * 1000
const WAIT_POLL_INTERVAL_MS = 250

export type PromaSelfApprovalKind = 'create-project'

/** 用户显式同意的回调；返回 false 表示拒绝。 */
export type PromaSelfApprovalRequester = (
  kind: PromaSelfApprovalKind,
  signal?: AbortSignal,
) => Promise<boolean>

export interface PromaSelfElement {
  ref: string
  role: string
  name: string
  editable: boolean
}

export interface PromaSelfSnapshot {
  title: string
  url: string
  generation: number
  elements: PromaSelfElement[]
}

export interface PromaSelfFindQuery {
  role?: string
  name?: string
  exact?: boolean
  maxResults?: number
}

export interface PromaSelfWaitCondition {
  kind: 'text' | 'selector'
  value: string
}

export interface PromaSelfDomActionInput {
  action: 'focus' | 'fill' | 'click' | 'inspect'
  selector: string
  text?: string
}

export interface PromaSelfScrollInput {
  selector?: string
  deltaY?: number
  position?: 'top' | 'bottom'
}

interface RefEntry {
  backendNodeId: number
  generation: number
  label: string
  editable: boolean
}

interface SessionState {
  generation: number
  refs: Map<string, RefEntry>
  commandTail: Promise<void>
  abortController: AbortController
  projectConsentExpiresAt?: number
}

function normalizeResult(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    if (serialized.length > MAX_SCRIPT_RESULT_CHARS) {
      return { truncated: true, preview: serialized.slice(0, MAX_SCRIPT_RESULT_CHARS), totalChars: serialized.length }
    }
    return JSON.parse(serialized)
  } catch {
    return String(value).slice(0, MAX_SCRIPT_RESULT_CHARS)
  }
}

function exceptionMessage(response: { exceptionDetails?: unknown }): string {
  const details = response.exceptionDetails
  if (!details || typeof details !== 'object') return 'Proma 界面操作失败。'
  const record = details as { exception?: unknown; text?: unknown }
  return cdpTextValue(record.exception) || cdpTextValue(record.text) || 'Proma 界面操作失败。'
}

export class PromaSelfController {
  private sessions = new Map<string, SessionState>()
  private monitoredDebuggers = new WeakSet<Electron.Debugger>()
  private attachedContents: WebContents | null = null

  constructor(private getWindow: () => Electron.BrowserWindow | null = getMainWindow) {}

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        generation: 0,
        refs: new Map(),
        commandTail: Promise.resolve(),
        abortController: new AbortController(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private window(): Electron.BrowserWindow {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('Proma 主窗口当前不可用，请在应用窗口恢复后重试。')
    }
    return window
  }

  private invalidateAll(): void {
    for (const state of this.sessions.values()) {
      state.generation += 1
      state.refs.clear()
    }
  }

  /** 主窗口的 debugger 需要在同一 WebContents 上附着且只挂一次 detach 监听。 */
  private ensureDebugger(contents: WebContents): void {
    const debuggerApi = contents.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    this.attachedContents = contents
    if (this.monitoredDebuggers.has(debuggerApi)) return
    this.monitoredDebuggers.add(debuggerApi)
    debuggerApi.on('detach', () => {
      if (this.attachedContents === contents) this.attachedContents = null
      this.invalidateAll()
    })
  }

  private async cdp(
    contents: WebContents,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfBrowserOperationAborted(signal)
    this.ensureDebugger(contents)
    const command = () => contents.debugger.sendCommand(method, params) as Promise<Record<string, unknown>>
    return timeoutMs === undefined
      ? withBrowserCdpTimeout(command, method, undefined, signal)
      : withBrowserCdpTimeout(command, method, timeoutMs, signal)
  }

  private async run<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    task: (window: Electron.BrowserWindow, operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const state = this.state(sessionId)
    const operationSignal = signal
      ? AbortSignal.any([state.abortController.signal, signal])
      : state.abortController.signal
    const operation = state.commandTail.catch(() => undefined).then(async () => {
      throwIfBrowserOperationAborted(operationSignal)
      return task(this.window(), operationSignal)
    })
    state.commandTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** 用户中断或会话结束时取消在途操作并作废旧 ref。 */
  cancelSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.abortController.abort()
    state.abortController = new AbortController()
    state.generation += 1
    state.refs.clear()
    state.projectConsentExpiresAt = undefined
  }

  private resolveRef(state: SessionState, ref: string): RefEntry {
    const entry = state.refs.get(ref)
    if (!entry || entry.generation !== state.generation) {
      throw new Error('界面元素引用已失效，请先重新调用 PromaObserve。')
    }
    return entry
  }

  private assertGeneration(state: SessionState, generation: number, signal: AbortSignal): void {
    throwIfBrowserOperationAborted(signal)
    if (state.generation !== generation) {
      throw new Error('Proma 界面已变化，请先重新调用 PromaObserve。')
    }
  }

  private metadata(window: Electron.BrowserWindow): { title: string; url: string } {
    return { title: window.getTitle() || 'Proma', url: window.webContents.getURL() }
  }

  private elementsFromNodes(
    state: SessionState,
    nodes: CdpAxNode[],
    maxElements: number,
    filter?: PromaSelfFindQuery,
  ): PromaSelfElement[] {
    const candidates: Array<{ backendNodeId: number; role: string; name: string; editable: boolean }> = []
    const roleFilter = filter?.role?.trim().toLowerCase()
    const nameFilter = filter?.name?.trim().toLowerCase()
    const interactionRoles = new Set(['button', 'textbox', 'link', 'checkbox', 'combobox'])

    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const backendNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : 0
      const role = cdpTextValue(node.role)
      const name = cdpTextValue(node.name)
      const editable = isEditableCdpAxNode(node)
      if (!backendNodeId || !role) continue
      if (!name && !editable && !interactionRoles.has(role)) continue
      if (roleFilter && role.toLowerCase() !== roleFilter) continue
      if (nameFilter) {
        const lowered = name.toLowerCase()
        if (filter?.exact ? lowered !== nameFilter : !lowered.includes(nameFilter)) continue
      }
      candidates.push({ backendNodeId, role, name: name.slice(0, browserObservationNameLimit(role)), editable })
      if (filter && candidates.length >= (filter.maxResults ?? 20)) break
    }

    const selected = filter ? candidates : prioritizeBrowserObservationCandidates(candidates, maxElements)
    state.generation += 1
    state.refs.clear()

    const elements: PromaSelfElement[] = []
    for (const candidate of selected) {
      const ref = `p${state.generation}-${elements.length + 1}`
      state.refs.set(ref, {
        backendNodeId: candidate.backendNodeId,
        generation: state.generation,
        label: candidate.name ? `${candidate.role}「${candidate.name.slice(0, 80)}」` : candidate.role,
        editable: candidate.editable,
      })
      elements.push({ ref, role: candidate.role, name: candidate.name, editable: candidate.editable })
    }
    return elements
  }

  async observe(sessionId: string, requestedMaxElements: number | undefined, signal?: AbortSignal): Promise<PromaSelfSnapshot> {
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const state = this.state(sessionId)
      const maxElements = resolveBrowserObserveMaxElements(requestedMaxElements)
      const response = await this.cdp(
        window.webContents,
        'Accessibility.getFullAXTree',
        { depth: resolveBrowserObserveAxDepth(maxElements) },
        BROWSER_OBSERVE_TIMEOUT_MS,
        operationSignal,
      )
      const nodes = Array.isArray(response.nodes) ? (response.nodes as CdpAxNode[]) : []
      const elements = this.elementsFromNodes(state, nodes, maxElements)
      return { ...this.metadata(window), generation: state.generation, elements }
    })
  }

  async find(sessionId: string, query: PromaSelfFindQuery, signal?: AbortSignal): Promise<PromaSelfSnapshot> {
    if (!query.role?.trim() && !query.name?.trim()) throw new Error('语义定位至少需要 role 或 name。')
    const maxResults = query.maxResults ?? 20
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error('maxResults 必须是 1 到 50 的整数。')
    }
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const state = this.state(sessionId)
      const response = await this.cdp(
        window.webContents,
        'Accessibility.getFullAXTree',
        { depth: resolveBrowserObserveAxDepth(400) },
        BROWSER_OBSERVE_TIMEOUT_MS,
        operationSignal,
      )
      const nodes = Array.isArray(response.nodes) ? (response.nodes as CdpAxNode[]) : []
      const elements = this.elementsFromNodes(state, nodes, maxResults, { ...query, maxResults })
      return { ...this.metadata(window), generation: state.generation, elements }
    })
  }

  private async executeExpression(contents: WebContents, expression: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.cdp(
      contents,
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      undefined,
      signal,
    )
    if (response.exceptionDetails) throw new Error(exceptionMessage(response))
    const result = response.result
    if (!result || typeof result !== 'object') return null
    const remote = result as { value?: unknown }
    return 'value' in remote ? normalizeResult(remote.value) : null
  }

  /** 元素是否属于「永远不能代点」或「需要用户同意」的类别。 */
  private async assertRefAllowed(
    contents: WebContents,
    target: RefEntry,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (isPromaSelfControlActionLabelProtected(target.label)) throw new Error(PROMA_SELF_CONTROL_PROTECTED_ERROR)
    const guard = createPromaSelfControlDomGuard()
    const resolved = await this.cdp(contents, 'DOM.resolveNode', { backendNodeId: target.backendNodeId }, undefined, signal)
    const object = resolved.object as { objectId?: unknown } | undefined
    const objectId = typeof object?.objectId === 'string' ? object.objectId : ''
    if (!objectId) throw new Error('界面元素已失效，请重新调用 PromaObserve。')

    const response = await this.cdp(contents, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { const isProtected = ${guard.protectionFunctionSource}; const isProjectCreation = ${guard.projectCreationFunctionSource}; return { protected: isProtected(this), projectCreation: isProjectCreation(this) }; }`,
      returnByValue: true,
    }, undefined, signal)

    const result = response.result as { value?: { protected?: boolean; projectCreation?: boolean } } | undefined
    const value = result?.value
    if (value?.protected === true) throw new Error(PROMA_SELF_CONTROL_PROTECTED_ERROR)
    return value?.projectCreation === true || isPromaSelfControlProjectCreationLabel(target.label)
  }

  private async assertActiveElementAllowed(contents: WebContents, signal: AbortSignal): Promise<boolean> {
    const guard = createPromaSelfControlDomGuard()
    const result = await this.executeExpression(
      contents,
      `(() => { const isProtected = ${guard.protectionFunctionSource}; const isProjectCreation = ${guard.projectCreationFunctionSource}; return { protected: isProtected(document.activeElement), projectCreation: isProjectCreation(document.activeElement) }; })()`,
      signal,
    )
    const value = result as { protected?: boolean; projectCreation?: boolean } | null
    if (value?.protected === true) throw new Error(PROMA_SELF_CONTROL_PROTECTED_ERROR)
    return value?.projectCreation === true
  }

  /**
   * 创建项目需要用户明确同意。
   * `continue` 模式复用刚取得的同意（同一次创建流程内的连续输入），避免反复打扰。
   */
  private async requireProjectApproval(
    state: SessionState,
    requestApproval: PromaSelfApprovalRequester | undefined,
    signal: AbortSignal,
    mode: 'start' | 'continue',
  ): Promise<void> {
    if (mode === 'continue' && (state.projectConsentExpiresAt ?? 0) > Date.now()) return
    if (!requestApproval) throw new Error(PROMA_SELF_CONTROL_PROJECT_CONSENT_ERROR)
    if (!(await requestApproval('create-project', signal))) throw new Error(PROMA_SELF_CONTROL_PROJECT_CONSENT_DENIED)
    state.projectConsentExpiresAt = Date.now() + PROJECT_CONSENT_TTL_MS
  }

  private async centerForRef(
    contents: WebContents,
    state: SessionState,
    ref: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const generation = state.generation
    const { backendNodeId } = this.resolveRef(state, ref)
    await this.cdp(contents, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }, undefined, signal)
    this.assertGeneration(state, generation, signal)
    const box = await this.cdp(contents, 'DOM.getBoxModel', { backendNodeId }, undefined, signal)
    const model = box.model as { content?: unknown } | undefined
    const quad = Array.isArray(model?.content) ? (model.content as unknown[]) : []
    if (quad.length < 8 || !quad.every((value) => typeof value === 'number')) {
      throw new Error('目标元素当前不可点击，请重新观察 Proma 界面。')
    }
    const numbers = quad as number[]
    return {
      x: (numbers[0]! + numbers[2]! + numbers[4]! + numbers[6]!) / 4,
      y: (numbers[1]! + numbers[3]! + numbers[5]! + numbers[7]!) / 4,
    }
  }

  private async clickRef(
    window: Electron.BrowserWindow,
    state: SessionState,
    ref: string,
    signal: AbortSignal,
    requestApproval: PromaSelfApprovalRequester | undefined,
  ): Promise<RefEntry> {
    const target = this.resolveRef(state, ref)
    if (await this.assertRefAllowed(window.webContents, target, signal)) {
      await this.requireProjectApproval(state, requestApproval, signal, 'start')
    }
    const generation = state.generation
    const { x, y } = await this.centerForRef(window.webContents, state, ref, signal)
    this.assertGeneration(state, generation, signal)
    // 滚动或等待期间界面可能重新渲染，点击前再校验一次。
    await this.assertRefAllowed(window.webContents, target, signal)
    await this.cdp(window.webContents, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, undefined, signal)
    this.assertGeneration(state, generation, signal)
    await this.cdp(window.webContents, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, undefined, signal)
    return target
  }

  async click(
    sessionId: string,
    ref: string,
    signal?: AbortSignal,
    requestApproval?: PromaSelfApprovalRequester,
  ): Promise<{ ok: true; label: string }> {
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const target = await this.clickRef(window, this.state(sessionId), ref, operationSignal, requestApproval)
      return { ok: true as const, label: target.label }
    })
  }

  async fill(
    sessionId: string,
    ref: string,
    text: string,
    signal?: AbortSignal,
    requestApproval?: PromaSelfApprovalRequester,
  ): Promise<{ ok: true; label: string; length: number }> {
    if (text.length > 10_000) throw new Error('单次输入不能超过 10000 个字符。')
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const state = this.state(sessionId)
      const target = this.resolveRef(state, ref)
      if (!target.editable) {
        throw new Error('目标不是可编辑字段，请重新观察后选择 input、textarea 或 contenteditable。')
      }
      if (await this.assertRefAllowed(window.webContents, target, operationSignal)) {
        await this.requireProjectApproval(state, requestApproval, operationSignal, 'continue')
      }
      await this.cdp(window.webContents, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId }, undefined, operationSignal)
      await this.cdp(window.webContents, 'DOM.focus', { backendNodeId: target.backendNodeId }, undefined, operationSignal)
      await this.assertRefAllowed(window.webContents, target, operationSignal)

      // 聚焦后必须确认焦点真的落在目标上，否则输入会跑进别的字段。
      const ax = await this.cdp(
        window.webContents,
        'Accessibility.getPartialAXTree',
        { backendNodeId: target.backendNodeId, fetchRelatives: false },
        undefined,
        operationSignal,
      )
      const nodes = Array.isArray(ax.nodes) ? (ax.nodes as CdpAxNode[]) : []
      const current = nodes.find((node) => node && node.backendDOMNodeId === target.backendNodeId)
      if (!current || !isEditableCdpAxNode(current) || !cdpAxPropertyBoolean(current, 'focused')) {
        throw new Error('无法聚焦目标字段，请重新观察 Proma 界面后重试。')
      }

      const modifier = process.platform === 'darwin' ? 4 : 2
      await this.cdp(window.webContents, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modifier }, undefined, operationSignal)
      await this.cdp(window.webContents, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: modifier }, undefined, operationSignal)
      await this.cdp(window.webContents, 'Input.insertText', { text }, undefined, operationSignal)
      return { ok: true as const, label: target.label, length: Array.from(text).length }
    })
  }

  async press(
    sessionId: string,
    key: string,
    signal?: AbortSignal,
    requestApproval?: PromaSelfApprovalRequester,
  ): Promise<{ ok: true }> {
    const action = parseBrowserPressAction(key)
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const state = this.state(sessionId)
      const projectCreation = await this.assertActiveElementAllowed(window.webContents, operationSignal)
      if (projectCreation) await this.requireProjectApproval(state, requestApproval, operationSignal, 'continue')

      if (action.kind === 'key') {
        const keyEvent = { key: action.key, code: action.code, windowsVirtualKeyCode: action.windowsVirtualKeyCode }
        await this.cdp(window.webContents, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent }, undefined, operationSignal)
        await this.cdp(window.webContents, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent }, undefined, operationSignal)
      } else {
        await this.cdp(window.webContents, 'Input.insertText', { text: action.text }, undefined, operationSignal)
      }

      // 回车通常就是「提交」，提交后同意即失效。
      if (projectCreation && action.kind === 'key' && action.key === 'Enter') {
        state.projectConsentExpiresAt = undefined
      }
      return { ok: true as const }
    })
  }

  async domAction(
    sessionId: string,
    input: PromaSelfDomActionInput,
    signal?: AbortSignal,
    requestApproval?: PromaSelfApprovalRequester,
  ): Promise<unknown> {
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const guard: BrowserDomActionGuard = createPromaSelfControlDomGuard()

      // 写操作前先 inspect 一次，判断是否需要用户同意；受保护元素直接拒绝。
      if (input.action === 'click' || input.action === 'fill') {
        const inspection = await this.executeExpression(
          window.webContents,
          buildBrowserDomActionExpression({ ...input, action: 'inspect' }, guard),
          operationSignal,
        )
        const result = inspection as {
          ok?: boolean
          error?: string
          protected?: boolean
          projectCreation?: boolean
          text?: string
          attributes?: { ariaLabel?: string | null; title?: string | null }
        } | null
        if (result?.protected === true) throw new Error(PROMA_SELF_CONTROL_PROTECTED_ERROR)
        if (result?.ok === false) return inspection
        if (result?.projectCreation === true) {
          const label = [result.text, result.attributes?.ariaLabel, result.attributes?.title]
            .filter((value): value is string => typeof value === 'string')
            .join(' ')
          const mode = isPromaSelfControlProjectCreationLabel(label) ? 'start' : 'continue'
          await this.requireProjectApproval(this.state(sessionId), requestApproval, operationSignal, mode)
        }
      }

      return this.executeExpression(
        window.webContents,
        buildBrowserDomActionExpression(input, guard),
        operationSignal,
      )
    })
  }

  async scroll(sessionId: string, input: PromaSelfScrollInput, signal?: AbortSignal): Promise<unknown> {
    return this.run(sessionId, signal, async (window, operationSignal) => (
      this.executeExpression(window.webContents, buildBrowserScrollExpression(input), operationSignal)
    ))
  }

  private assertWait(condition: PromaSelfWaitCondition, timeoutMs: number): void {
    if (!condition.value.trim()) throw new Error('等待条件不能为空。')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error('等待超时必须在 250 到 30000 毫秒之间。')
    }
  }

  private async waitForInternal(
    window: Electron.BrowserWindow,
    condition: PromaSelfWaitCondition,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ matched: boolean }> {
    const startedAt = Date.now()
    // 条件作为数据注入，避免被当作代码执行。
    const payload = JSON.stringify(condition).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const expression = `(() => { const condition = ${payload}; try { if (condition.kind === 'text') return (document.body?.innerText || '').includes(condition.value); return !!document.querySelector(condition.value); } catch { return false; } })()`

    while (Date.now() - startedAt <= timeoutMs) {
      throwIfBrowserOperationAborted(signal)
      if (await this.executeExpression(window.webContents, expression, signal) === true) return { matched: true }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, WAIT_POLL_INTERVAL_MS)
        const abort = (): void => {
          clearTimeout(timer)
          reject(new BrowserOperationAbortedError())
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    return { matched: false }
  }

  async waitFor(
    sessionId: string,
    condition: PromaSelfWaitCondition,
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<{ matched: boolean }> {
    this.assertWait(condition, timeoutMs)
    return this.run(sessionId, signal, async (window, operationSignal) => (
      this.waitForInternal(window, condition, timeoutMs, operationSignal)
    ))
  }

  async act(
    sessionId: string,
    ref: string,
    waitFor: PromaSelfWaitCondition | undefined,
    timeoutMs = 10_000,
    signal?: AbortSignal,
    requestApproval?: PromaSelfApprovalRequester,
  ): Promise<{ ok: true; label: string; wait: { matched: boolean } | null }> {
    if (waitFor) this.assertWait(waitFor, timeoutMs)
    return this.run(sessionId, signal, async (window, operationSignal) => {
      const target = await this.clickRef(window, this.state(sessionId), ref, operationSignal, requestApproval)
      const wait = waitFor ? await this.waitForInternal(window, waitFor, timeoutMs, operationSignal) : null
      return { ok: true as const, label: target.label, wait }
    })
  }

  async screenshot(sessionId: string, signal?: AbortSignal): Promise<{ mimeType: string; base64: string }> {
    return this.run(sessionId, signal, async (window, operationSignal) => {
      throwIfBrowserOperationAborted(operationSignal)
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error('Proma 窗口截图为空，请恢复窗口后重试或改用 PromaObserve。')
      const { width, height } = image.getSize()
      if (width <= 0 || height <= 0) throw new Error('Proma 窗口截图尺寸无效，请恢复窗口后重试。')
      const buffer = image.toPNG()
      if (!isValidImageBytes('image/png', buffer)) throw new Error('Proma 窗口截图数据无效，请重试。')
      if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
        throw new Error('Proma 窗口截图过大，请缩小窗口或改用 PromaObserve。')
      }
      return { mimeType: 'image/png', base64: buffer.toString('base64') }
    })
  }

  /** 会话结束时清理引用与在途操作。 */
  disposeSession(sessionId: string): void {
    this.cancelSession(sessionId)
    this.sessions.delete(sessionId)
  }
}

export const promaSelfController = new PromaSelfController()
