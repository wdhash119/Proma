/**
 * Computer Use 预览工具（ComputerUsePreview）。
 *
 * 只在用户主会话里提供：自动化任务、协作子会话与外部 Bridge 没有可见窗口，
 * 展示镜像既无法被用户看到，也无法被中断。工具本身不执行任何点击，只登记
 * 预览目标；真正的采集由主进程预览服务按需完成。
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ComputerUsePreviewState } from '@proma/shared'
import { Type } from 'typebox'
import {
  computerUsePreview,
  type ComputerUsePreviewShowInput,
} from '../computer-use-preview'

/** 只约束真正用到的 defineTool；与 Pi SDK 的泛型签名保持结构兼容。 */
interface ToolSdk {
  defineTool: (definition: never) => unknown
}

export interface ComputerUseToolsContext {
  sessionId: string
}

/** 纯文本回执：预览结论只是一句话，不需要 JSON 包装。 */
function textToolResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details: {},
  } as AgentToolResult<unknown>
}

/** 把内部状态整理成给模型的简短回执，避免把 base64 画面写回上下文。 */
function describePreviewOutcome(
  input: ComputerUsePreviewShowInput,
  snapshot: ComputerUsePreviewState | null,
): string {
  if (input.action === 'finish') return '预览已结束。'
  if (snapshot?.error) return `${snapshot.error} 可继续原有桌面操作链路，不要为预览重复安装。`
  if (!snapshot) return '预览已关闭。'
  return '已显示操作预览。Proma 会在此会话可见时刷新画面；预览不代替 Agent 的截图观察。'
}

export function buildComputerUseTools(sdk: ToolSdk, ctx: ComputerUseToolsContext): unknown[] {
  const defineTool = sdk.defineTool as (definition: unknown) => unknown
  return [
    defineTool({
      name: 'ComputerUsePreview',
      label: '显示桌面操作预览',
      description: '在 Proma 右侧展示当前 Computer Use 目标的窗口镜像。使用 Cua 或 AppleScript 操作、截图本机 App 窗口前，在 Cua list_windows 确认窗口后调用 show；切换目标时再次 show；结束时调用 finish。纯浏览器 DOM/API 读取不需要窗口预览。预览不可用时继续原有任务。只显示画面，不执行点击，不返回截图给模型。桌面预览仅用于用户任务确实需要操作整个桌面的场景。',
      promptSnippet: '操作或截图本机 App 窗口（包括 Cua、AppleScript）时用 ComputerUsePreview 展示目标，切换窗口时更新，完成后 finish。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('show'), Type.Literal('finish')]),
        target: Type.Optional(Type.Union([Type.Literal('window'), Type.Literal('desktop')])),
        label: Type.Optional(Type.String({ description: '展示给用户的应用或窗口名称。' })),
        pid: Type.Optional(Type.Integer({ minimum: 1 })),
        windowId: Type.Optional(Type.Integer({ minimum: 1, description: 'list_windows 返回的 window_id。' })),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
        if (signal?.aborted) throw new Error('操作已取消')
        const input = (params ?? {}) as ComputerUsePreviewShowInput
        computerUsePreview.show(ctx.sessionId, ctx.sessionId, input)
        const snapshot = input.action === 'show' ? await computerUsePreview.get(ctx.sessionId, true) : null
        return textToolResult(describePreviewOutcome(input, snapshot))
      },
    }),
  ]
}
