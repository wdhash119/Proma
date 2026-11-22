import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { createVisionRelayReadToolDefinition } from './pi-vision-relay-read'
import type { InspectImageInput, VisionRelayResult } from '../vision-relay-service'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type ReadToolInput = { path: string; offset?: number; limit?: number }

const PROCESS_CWD = resolve(process.cwd())

/** fake Read 的固定返回，用于区分文本与图片路径。 */
function createTextResult(text: string): unknown {
  return {
    content: [{ type: 'text', text }],
    details: { truncation: undefined },
    structuredContent: text,
  }
}

function createImageResult(): unknown {
  return {
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png' },
    ],
    details: { imageUnsupportedByModel: 'text-only-model' },
    structuredContent: { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png', note: 'Read image file [image/png]' },
  }
}

interface FakeSdkOptions {
  result: unknown
  /** 记录 fake Read 收到的原始参数，验证包装层没有篡改。 */
  received?: ReadToolInput[]
}

function createFakeSdk(options: FakeSdkOptions): PiSdk {
  return {
    createReadToolDefinition: (): ToolDefinition => ({
      name: 'read',
      label: 'read',
      description: `Read the contents of a file. Supports text files and images. Images are sent as attachments. For text files, output is truncated.`,
      parameters: {},
      async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> {
        options.received?.push(params as ReadToolInput)
        return options.result as AgentToolResult<unknown>
      },
    }),
  } as unknown as PiSdk
}

interface InspectCall {
  input: InspectImageInput
}

function createInspect(result: VisionRelayResult): { calls: InspectCall[]; inspectImage: (input: InspectImageInput) => Promise<VisionRelayResult> } {
  const calls: InspectCall[] = []
  return {
    calls,
    async inspectImage(input) {
      calls.push({ input })
      return result
    },
  }
}

function executeRead(
  definition: ToolDefinition,
  input: ReadToolInput,
  ctxCwd?: string,
): Promise<AgentToolResult<unknown>> {
  return definition.execute(
    'tool-call-1',
    input,
    undefined,
    undefined,
    { cwd: ctxCwd } as Parameters<ToolDefinition['execute']>[4],
  )
}

const ALLOWED_ROOTS = ['/workspace/session', '/workspace/attached']

describe('强制档的 Read 包装：文本结果', () => {
  test('Given 读取文本文件 When 执行 Read Then 原样返回且不调用视觉模型', async () => {
    const received: ReadToolInput[] = []
    const sdk = createFakeSdk({ result: createTextResult('hello'), received })
    const inspect = createInspect({ ok: true, result: { status: 'ok' } })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    const result = await executeRead(definition, { path: 'notes.txt' }, '/workspace/session')

    expect(result).toEqual(createTextResult('hello') as AgentToolResult<unknown>)
    expect(inspect.calls).toHaveLength(0)
    expect(received).toEqual([{ path: 'notes.txt' }])
  })

  test('Given 强制档 When 生成 Read 定义 Then 保留原生名称与参数并声明图片不再作为附件', () => {
    const sdk = createFakeSdk({ result: createTextResult('hello') })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: createInspect({ ok: true, result: { status: 'ok' } }).inspectImage,
    })

    expect(definition.name).toBe('read')
    expect(definition.label).toBe('read')
    expect(definition.description).toContain('Images are never attached to the current model')
    expect(definition.description).not.toContain('Images are sent as attachments.')
  })
})

describe('强制档的 Read 包装：图片结果', () => {
  test('Given 读取图片 When 执行 Read Then 调用一次视觉模型并只返回文本 JSON', async () => {
    const sdk = createFakeSdk({ result: createImageResult() })
    const inspect = createInspect({
      ok: true,
      result: {
        status: 'ok',
        source: { filename: 'chart.jpg' },
        result: { answer: '一张折线图', observations: ['上升趋势'], limitations: [] },
        safety: { untrustedSource: true },
      },
    })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    const result = await executeRead(definition, { path: 'assets/chart.png' }, '/workspace/session')

    expect(inspect.calls).toHaveLength(1)
    expect(inspect.calls[0]?.input.imagePath).toBe(resolve('/workspace/session', 'assets/chart.png'))
    expect(inspect.calls[0]?.input.allowedRoots).toEqual(ALLOWED_ROOTS)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe('text')
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo')
    expect(result.isError).toBeUndefined()

    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
    expect(payload.status).toBe('ok')
    expect(payload.relay).toEqual({ mode: 'force' })
    expect((payload.result as Record<string, unknown>).answer).toBe('一张折线图')
  })

  test('Given 视觉模型失败 When 执行 Read Then 不含 image block 且标记 isError', async () => {
    const sdk = createFakeSdk({ result: createImageResult() })
    const inspect = createInspect({
      ok: false,
      code: 'VISION_PROVIDER_ERROR',
      message: '视觉模型调用失败：timeout',
    })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    const result = await executeRead(definition, { path: '/workspace/session/a.png' }, '/workspace/session')

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content.some((block) => block.type === 'image')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo')

    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
    expect(payload.status).toBe('error')
    expect(payload.code).toBe('VISION_PROVIDER_ERROR')
  })

  test('Given 相对路径 When 执行上下文 cwd 与工具 cwd 不同 Then 按 ctx.cwd 解析', async () => {
    const sdk = createFakeSdk({ result: createImageResult() })
    const inspect = createInspect({ ok: true, result: { status: 'ok' } })
    const definition = createVisionRelayReadToolDefinition(sdk, PROCESS_CWD, {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    await executeRead(definition, { path: join('sub', 'shot.png') }, '/workspace/session')

    expect(inspect.calls[0]?.input.imagePath).toBe(resolve('/workspace/session', 'sub', 'shot.png'))
    expect(inspect.calls[0]?.input.imagePath).not.toBe(resolve(PROCESS_CWD, 'sub', 'shot.png'))
  })

  test('Given 执行上下文未提供 cwd When 执行 Read Then 回退到工具 cwd', async () => {
    const sdk = createFakeSdk({ result: createImageResult() })
    const inspect = createInspect({ ok: true, result: { status: 'ok' } })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    await executeRead(definition, { path: 'shot.png' })

    expect(inspect.calls[0]?.input.imagePath).toBe(resolve('/workspace/session', 'shot.png'))
  })

  test('Given 请求路径使用 ~ 缩写 When 执行 Read Then 展开到用户主目录而不是 cwd 子目录', async () => {
    const sdk = createFakeSdk({ result: createImageResult() })
    const inspect = createInspect({ ok: true, result: { status: 'ok' } })
    const definition = createVisionRelayReadToolDefinition(sdk, '/workspace/session', {
      allowedRoots: ALLOWED_ROOTS,
      inspectImage: inspect.inspectImage,
    })

    await executeRead(definition, { path: '~/shot.png' }, '/workspace/session')

    expect(inspect.calls[0]?.input.imagePath).toBe(resolve(homedir(), 'shot.png'))
    expect(inspect.calls[0]?.input.imagePath).not.toBe(resolve('/workspace/session', '~/shot.png'))
  })
})
