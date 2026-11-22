/**
 * 视觉助手“强制档”的 Read 工具包装。
 *
 * 强制档下，当前模型不允许接收任何 image content：图片 Read 的结果在进入 transcript
 * 之前被替换为视觉模型返回的文本 JSON。文本 Read 完全沿用 Pi 原生实现，不触发视觉请求。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { serializePiToolResultPayload } from './pi-tool-result-json'
import { resolvePathAgainstAgentCwd } from '../agent-file-path'
import type { InspectImageInput, VisionRelayResult } from '../vision-relay-service'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

interface VisionRelayReadOptions {
  /** 图片外发前必须校验在这些已授权目录内。 */
  allowedRoots: string[]
  /** 视觉中转调用；测试注入 fake，运行时为 inspectImageWithVisionRelay。 */
  inspectImage: (input: InspectImageInput) => Promise<VisionRelayResult>
}

const FORCE_MODE_DESCRIPTION = 'Images are never attached to the current model in this session: '
  + 'a configured vision model inspects the image file and only its text JSON result is returned here. '
  + 'For a focused question about the image, call VisionRelay directly instead.'

function buildForcedReadDescription(base: string): string {
  const replaced = base.includes('Images are sent as attachments.')
    ? base.replace('Images are sent as attachments.', FORCE_MODE_DESCRIPTION)
    : `${base} ${FORCE_MODE_DESCRIPTION}`
  return replaced
}

function createTextOnlyResult(payload: unknown, isError: boolean): AgentToolResult<unknown> {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text', text: serialized.text }],
    details: serialized.details,
    ...(isError ? { isError: true } : {}),
  }
}

function hasImageContent(result: AgentToolResult<unknown>): boolean {
  return result.content.some((block) => block.type === 'image')
}

/**
 * 构造包装后的 Read 工具定义。
 *
 * 名称、schema、权限与渲染行为全部继承 Pi 原生定义；只有图片结果被替换为文本。
 */
export function createVisionRelayReadToolDefinition(
  sdk: PiSdk,
  cwd: string,
  options: VisionRelayReadOptions,
): ToolDefinition {
  const baseDefinition = sdk.createReadToolDefinition(cwd) as unknown as ToolDefinition
  const baseExecute = baseDefinition.execute

  return {
    ...baseDefinition,
    description: buildForcedReadDescription(baseDefinition.description),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await baseExecute(toolCallId, params, signal, onUpdate, ctx)
      if (!hasImageContent(result)) return result

      // 与 Pi Read 使用同一套路径语义（含 `~` 展开），不复用工具返回的 base64 另起链路。
      const requestPath = params !== null && typeof params === 'object' && typeof (params as { path?: unknown }).path === 'string'
        ? (params as { path: string }).path
        : ''
      const imagePath = requestPath ? resolvePathAgainstAgentCwd(requestPath, ctx?.cwd || cwd) : ''
      const inspected = await options.inspectImage({
        imagePath,
        allowedRoots: options.allowedRoots,
        signal,
      })

      if (!inspected.ok) {
        return createTextOnlyResult({
          status: 'error',
          code: inspected.code,
          message: inspected.message,
          imagePath,
          relay: { mode: 'force' },
        }, true)
      }
      return createTextOnlyResult({
        ...inspected.result,
        relay: { mode: 'force' },
      }, false)
    },
  }
}
