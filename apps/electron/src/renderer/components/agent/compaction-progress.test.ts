import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { getContextCompactionProgress, hasRenderableAssistantTurnContent, isCompactionControlHistoryGroup, shouldRenderLiveAssistantTurn } from './AgentMessages'
import { buildCompactionNoticeText, COMPACTION_NOTICE_RETENTION_MS } from './CompactionNotice'

function systemMessage(fields: Record<string, unknown>): SDKMessage {
  return { type: 'system', ...fields } as unknown as SDKMessage
}

function assistantMessage(): SDKMessage {
  return { type: 'assistant', message: { content: [] } } as unknown as SDKMessage
}

describe('context compaction progress state', () => {
  test('keeps the optimistic timer shell until a live assistant turn has visible content', () => {
    const assistantTurn = (content: unknown[], error?: { message: string }) => ({
      type: 'assistant-turn',
      assistantMessages: [{
        type: 'assistant',
        message: { content },
        parent_tool_use_id: null,
        error,
      }],
      turnMessages: [],
    } as Parameters<typeof hasRenderableAssistantTurnContent>[0])

    const emptyTextTurn = assistantTurn([{ type: 'text', text: '' }])
    const contentTurn = assistantTurn([{ type: 'text', text: '开始执行' }])

    expect(hasRenderableAssistantTurnContent(assistantTurn([]))).toBe(false)
    expect(hasRenderableAssistantTurnContent(emptyTextTurn)).toBe(false)
    expect(hasRenderableAssistantTurnContent(assistantTurn([{ type: 'thinking', thinking: '' }]))).toBe(false)
    expect(hasRenderableAssistantTurnContent(assistantTurn([{ type: 'tool_use', name: 'TaskUpdate' }]))).toBe(true)
    expect(hasRenderableAssistantTurnContent(contentTurn)).toBe(true)
    expect(hasRenderableAssistantTurnContent(assistantTurn([{ type: 'tool_use', name: 'Bash' }]))).toBe(true)
    expect(hasRenderableAssistantTurnContent(assistantTurn([{ type: 'custom_block' }]))).toBe(true)
    expect(hasRenderableAssistantTurnContent(assistantTurn([], { message: '请求失败' }))).toBe(true)

    expect(shouldRenderLiveAssistantTurn(emptyTextTurn, true)).toBe(false)
    expect(shouldRenderLiveAssistantTurn(emptyTextTurn, false)).toBe(true)
    expect(shouldRenderLiveAssistantTurn(contentTurn, true)).toBe(true)
  })

  test('hides /compact control messages from conversation history', () => {
    expect(isCompactionControlHistoryGroup({
      type: 'user',
      message: { type: 'user', message: { content: [{ type: 'text', text: '/compact' }] } },
    } as never)).toBe(true)
    expect(isCompactionControlHistoryGroup({
      type: 'system',
      message: { type: 'system', subtype: 'compact_boundary' },
    } as never)).toBe(true)
    expect(isCompactionControlHistoryGroup({
      type: 'user',
      message: { type: 'user', message: { content: [{ type: 'text', text: '继续处理当前任务' }] } },
    } as never)).toBe(false)
  })


  test('shows a running state before the SDK emits a compacting message', () => {
    expect(getContextCompactionProgress([], true, undefined)).toMatchObject({
      status: 'running',
      label: '正在整理上下文',
    })
  })

  test('retains a no-op terminal state after live messages are cleared', () => {
    expect(getContextCompactionProgress([], false, {
      status: 'noop',
      message: '当前上下文较小，暂时无需压缩。',
    })).toMatchObject({
      status: 'noop',
      label: '当前上下文无需压缩',
    })
  })

  test('renders compaction progress as a single line of body-size text', () => {
    const running = getContextCompactionProgress([], true, undefined)
    expect(running && buildCompactionNoticeText(running)).toBe('正在整理上下文：正在生成会话摘要，完成后可继续当前任务。')

    const success = getContextCompactionProgress([
      systemMessage({ subtype: 'compact_boundary', summary: '已完成的工作已整理。' }),
    ], false, undefined)
    expect(success && buildCompactionNoticeText(success)).toBe('上下文已压缩：会话已整理，可以继续当前任务。')

    const noop = getContextCompactionProgress([
      systemMessage({ subtype: 'status', compact_result: 'noop', message: '当前上下文较小，暂时无需压缩。' }),
    ], false, undefined)
    expect(noop && buildCompactionNoticeText(noop)).toBe('当前上下文无需压缩：当前上下文较小，暂时无需压缩。')

    const failed = getContextCompactionProgress([
      systemMessage({ subtype: 'status', compact_result: 'failed', compact_error: 'provider unavailable' }),
    ], false, undefined)
    expect(failed && buildCompactionNoticeText(failed)).toBe('上下文压缩失败：provider unavailable')

    // 终态提示保留数秒后自动消失，不长期占用对话流。
    expect(COMPACTION_NOTICE_RETENTION_MS).toBeGreaterThan(0)
    expect(COMPACTION_NOTICE_RETENTION_MS).toBeLessThanOrEqual(10_000)
  })

  test('maps successful compaction to a terminal state', () => {
    expect(getContextCompactionProgress([
      systemMessage({ subtype: 'compact_boundary', summary: '已完成的工作已整理。' }),
    ], false, undefined)).toMatchObject({
      status: 'success',
      label: '上下文已压缩',
      summary: '已完成的工作已整理。',
    })
  })

  test('does not revive an old compaction boundary after Pi continues with assistant or task work', () => {
    const compactionBoundary = systemMessage({ subtype: 'compact_boundary', summary: '已完成的工作已整理。' })

    expect(getContextCompactionProgress([
      compactionBoundary,
      assistantMessage(),
    ], false, { status: 'success' })).toBeUndefined()
    expect(getContextCompactionProgress([
      compactionBoundary,
      systemMessage({ subtype: 'task_started', task_id: 'continued-task' }),
    ], false, { status: 'success' })).toBeUndefined()
  })

  test('maps a no-op result to a clear terminal state', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'noop',
        message: '当前上下文较小，暂时无需压缩。',
      }),
    ], false, undefined)).toMatchObject({
      status: 'noop',
      label: '当前上下文无需压缩',
    })
  })

  test('keeps compaction failures visible with their error details', () => {
    expect(getContextCompactionProgress([
      systemMessage({
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'provider unavailable',
      }),
    ], false, undefined)).toMatchObject({
      status: 'failed',
      detail: 'provider unavailable',
    })
  })
})
