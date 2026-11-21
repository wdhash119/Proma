/**
 * Proma 自操作工具（PromaObserve / PromaFind / PromaClick / …）。
 *
 * 只在用户主会话里提供：自动化任务、协作子会话和外部 Bridge 没有可见窗口，
 * 让它们操作 Proma 界面既无法验证也无法被用户中断。
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { promaSelfController, type PromaSelfApprovalRequester } from '../proma-self-controller'

export interface PromaSelfToolsContext {
  sessionId: string
  /** 用户是否已显式同意某个高副作用动作（目前仅创建项目）。 */
  requestPromaSelfApproval?: PromaSelfApprovalRequester
}

/** 只约束真正用到的 defineTool；与 Pi SDK 的泛型签名保持结构兼容。 */
interface ToolSdk {
  defineTool: (definition: never) => unknown
}

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

export function buildPromaSelfTools(sdk: ToolSdk, ctx: PromaSelfToolsContext): unknown[] {
  const defineTool = sdk.defineTool as (definition: unknown) => unknown
  return [
    defineTool({
      name: 'PromaObserve',
      label: '观察 Proma 界面',
      description: '通过内部调试通道读取 Proma 主窗口的标题与紧凑可访问性快照。用户要求查看或操作 Proma 自身、且没有专用业务工具时使用。每次 PromaObserve 或 PromaFind 都会作废之前的 ref。快照元素多时用 PromaFind 按 role/name 精确定位，不要凭顺序猜要点的按钮。受管网页不要用这个，改用 BrowserObserve。',
      parameters: Type.Object({
        maxElements: Type.Optional(Type.Number({ minimum: 20, maximum: 400, description: '返回元素上限。默认 240；只有复杂界面找不到目标时才用 400。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { maxElements?: unknown }
        return jsonToolResult(await promaSelfController.observe(
          ctx.sessionId,
          typeof input.maxElements === 'number' ? input.maxElements : undefined,
          signal,
        ))
      },
    }),
    defineTool({
      name: 'PromaFind',
      label: '定位 Proma 控件',
      description: '按 role 和/或可访问名称在 Proma 主窗口里查找新鲜的 ref，不返回完整快照，并作废之前的 ref。PromaObserve 太大或漏掉目标时优先用它。',
      parameters: Type.Object({
        role: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '可访问性角色，例如 button、textbox、tab、checkbox、combobox。' })),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: '可访问名称查询。' })),
        exact: Type.Optional(Type.Boolean({ description: '名称需要精确匹配，而不是大小写不敏感的子串匹配。' })),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: '最多返回条数，默认 20。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as Record<string, unknown>
        return jsonToolResult(await promaSelfController.find(ctx.sessionId, {
          ...(typeof input.role === 'string' ? { role: input.role } : {}),
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          exact: input.exact === true,
          ...(typeof input.maxResults === 'number' ? { maxResults: input.maxResults } : {}),
        }, signal))
      },
    }),
    defineTool({
      name: 'PromaClick',
      label: '点击 Proma 控件',
      description: '用 CDP 输入点击最新 PromaObserve/PromaFind 返回的 ref。受保护的输入区、AskUserQuestion 选项、密码框与弹窗确认会被拒绝。创建项目前必须先通过 AskUserQuestion 取得用户同意。',
      parameters: Type.Object({
        ref: Type.String({ description: '来自最新 PromaObserve 或 PromaFind 的元素引用。' }),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { ref?: unknown }
        return jsonToolResult(await promaSelfController.click(
          ctx.sessionId,
          typeof input.ref === 'string' ? input.ref : '',
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    defineTool({
      name: 'PromaAct',
      label: '点击并等待 Proma 状态',
      description: '点击一个当前 Proma ref，并在同一次操作里等待可见文本或 CSS selector 出现。已知点击后的预期界面状态时优先用它，而不是分成点击和等待两次调用。点击已执行但等待未匹配时，结果会带回当前可见文本，据此判断是文案不同还是界面未打开。',
      parameters: Type.Object({
        ref: Type.String({ description: '来自最新 PromaObserve 或 PromaFind 的元素引用。' }),
        waitFor: Type.Optional(Type.Object({
          kind: Type.Union([Type.Literal('text'), Type.Literal('selector')]),
          value: Type.String({ minLength: 1, maxLength: 2000, description: '期望出现的可见文本或 CSS selector。' }),
        })),
        timeoutMs: Type.Optional(Type.Number({ minimum: 250, maximum: 30000, description: '提供 waitFor 时的最长等待时间，默认 10000。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { ref?: unknown; waitFor?: { kind?: unknown; value?: unknown }; timeoutMs?: unknown }
        const kind = input.waitFor?.kind
        const waitFor = (kind === 'text' || kind === 'selector') && typeof input.waitFor?.value === 'string'
          ? { kind, value: input.waitFor.value } as const
          : undefined
        return jsonToolResult(await promaSelfController.act(
          ctx.sessionId,
          typeof input.ref === 'string' ? input.ref : '',
          waitFor,
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000,
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    defineTool({
      name: 'PromaFill',
      label: '填写 Proma 字段',
      description: '替换引用到的非敏感 Proma 输入框、textarea 或 contenteditable 的全部文本。输入区与密码框受保护。填写本身不会提交，请随后校验界面状态。',
      parameters: Type.Object({
        ref: Type.String({ description: '来自最新 PromaObserve 或 PromaFind 的可编辑元素引用。' }),
        text: Type.String({ maxLength: 10000, description: '完整替换文本，可包含 Unicode 与换行。' }),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { ref?: unknown; text?: unknown }
        return jsonToolResult(await promaSelfController.fill(
          ctx.sessionId,
          typeof input.ref === 'string' ? input.ref : '',
          typeof input.text === 'string' ? input.text : '',
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    defineTool({
      name: 'PromaPress',
      label: '按下 Proma 按键',
      description: '向当前已聚焦的安全 Proma 编辑器发送导航键或插入完整文本。有字段 ref 时优先用 PromaFill。受保护的聚焦控件会在发送任何按键前被拒绝。',
      parameters: Type.Object({
        key: Type.String({ description: '导航键（如 Enter、Tab、Escape）或要插入到聚焦编辑器的完整文本。' }),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { key?: unknown }
        return jsonToolResult(await promaSelfController.press(
          ctx.sessionId,
          typeof input.key === 'string' ? input.key : '',
          signal,
          ctx.requestPromaSelfApproval,
        ))
      },
    }),
    defineTool({
      name: 'PromaDomAction',
      label: '操作 Proma DOM 控件',
      description: 'PromaObserve 找不到动态或富文本控件时，用 CSS selector 做固定的 focus、fill、click 或 inspect。selector 与 text 只是数据，不会被执行成代码。受保护元素会被拒绝。优先使用语义 ref。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('focus'),
          Type.Literal('fill'),
          Type.Literal('click'),
          Type.Literal('inspect'),
        ]),
        selector: Type.String({ minLength: 1, maxLength: 1000, description: '目标 Proma 元素的 CSS selector。' }),
        text: Type.Optional(Type.String({ maxLength: 10000, description: 'fill 时必填，替换完整值并派发 input/change。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { action?: unknown; selector?: unknown; text?: unknown }
        const action = input.action
        if (action !== 'focus' && action !== 'fill' && action !== 'click' && action !== 'inspect') {
          throw new Error('不支持的 Proma DOM 操作。')
        }
        return jsonToolResult(await promaSelfController.domAction(ctx.sessionId, {
          action,
          selector: typeof input.selector === 'string' ? input.selector : '',
          ...(typeof input.text === 'string' ? { text: input.text } : {}),
        }, signal, ctx.requestPromaSelfApproval))
      },
    }),
    defineTool({
      name: 'PromaScroll',
      label: '滚动 Proma 界面',
      description: '用固定操作滚动 Proma 文档或 CSS 选中的内部滚动容器。deltaY 与 position 只能指定一个。',
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: '可选，滚动容器的 CSS selector。省略时滚动文档。' })),
        deltaY: Type.Optional(Type.Number({ minimum: -50000, maximum: 50000, description: '带符号的垂直滚动距离（CSS 像素）。' })),
        position: Type.Optional(Type.Union([Type.Literal('top'), Type.Literal('bottom')])),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { selector?: unknown; deltaY?: unknown; position?: unknown }
        const position = input.position
        if (position !== undefined && position !== 'top' && position !== 'bottom') {
          throw new Error('不支持的滚动位置。')
        }
        return jsonToolResult(await promaSelfController.scroll(ctx.sessionId, {
          ...(typeof input.selector === 'string' ? { selector: input.selector } : {}),
          ...(typeof input.deltaY === 'number' ? { deltaY: input.deltaY } : {}),
          ...(position === 'top' || position === 'bottom' ? { position } : {}),
        }, signal))
      },
    }),
    defineTool({
      name: 'PromaWaitFor',
      label: '等待 Proma 界面状态',
      description: '等待 Proma 主窗口出现固定可见文本或 CSS selector。超时返回 matched=false，并带回当前可见文本帮助你判断界面实际状态；绝不执行 Agent 提供的 JavaScript。',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('text'), Type.Literal('selector')]),
        value: Type.String({ minLength: 1, maxLength: 2000, description: '可见文本或 CSS selector。' }),
        timeoutMs: Type.Optional(Type.Number({ minimum: 250, maximum: 30000, description: '最长等待毫秒数，默认 10000。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        const input = params as { kind?: unknown; value?: unknown; timeoutMs?: unknown }
        const kind = input.kind
        if (kind !== 'text' && kind !== 'selector') throw new Error('不支持的等待条件。')
        return jsonToolResult(await promaSelfController.waitFor(
          ctx.sessionId,
          { kind, value: typeof input.value === 'string' ? input.value : '' },
          typeof input.timeoutMs === 'number' ? input.timeoutMs : 10_000,
          signal,
        ))
      },
    }),
    defineTool({
      name: 'PromaScreenshot',
      label: '截取 Proma 界面',
      description: '把当前 Proma 主窗口截成 PNG 用于视觉核对。语义结构足够时先用 PromaObserve。',
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: unknown, signal?: AbortSignal) {
        const screenshot = await promaSelfController.screenshot(ctx.sessionId, signal)
        return {
          content: [
            { type: 'text', text: '已截取当前 Proma 主窗口。' },
            { type: 'image', data: screenshot.base64, mimeType: screenshot.mimeType },
          ],
          details: { mimeType: screenshot.mimeType, bytes: Math.floor(screenshot.base64.length * 0.75) },
        } as AgentToolResult<unknown>
      },
    }),
  ]
}
