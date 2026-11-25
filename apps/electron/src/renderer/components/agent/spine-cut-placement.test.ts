/**
 * 跨层契约测试：会话转录 → groupIntoTurns 分组 → 渲染层锚点定位 → 过程流布局，
 * 端到端守住「切割事件落在它实际发生的工具行之间」这条链路。
 *
 * 回归背景：切割事件曾在渲染时被整批挑出、追加到过程流末尾，看起来「堆在信息流末端」，
 * 而不是像工具调用那样停在发生位置。分组层保留了时间顺序，定位层依赖一个隐含契约：
 * AssistantTurn.assistantMessages 与 turnMessages 里的 assistant 序列同源同序
 * （isReplay 消息两边都被跳过）。本测试同时守住这个契约，避免日后单改一层导致锚点错位。
 */

import { describe, expect, test } from 'bun:test'
import {
  groupIntoTurns,
  readSessionMessagesFromString,
  type AssistantTurn,
} from '@proma/session-core'
import type { SDKContentBlock, SDKMessage } from '@proma/shared'
import { locateSpineCutEvents } from './SpineCutNotice'
import { buildAssistantTurnRenderItems } from './ProcessBlockGroup'

function jsonl(lines: SDKMessage[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

const userText = (text: string): SDKMessage => ({
  type: 'user',
  message: { content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
} as unknown as SDKMessage)

const assistantTool = (id: string, name: string): SDKMessage => ({
  type: 'assistant',
  message: { id, model: 'claude-test', content: [{ type: 'tool_use', id, name, input: {} }] },
  parent_tool_use_id: null,
} as unknown as SDKMessage)

const assistantText = (id: string, text: string): SDKMessage => ({
  type: 'assistant',
  message: { id, model: 'claude-test', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
} as unknown as SDKMessage)

const toolResult = (toolUseId: string): SDKMessage => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  parent_tool_use_id: null,
} as unknown as SDKMessage)

const cut = (count: number): SDKMessage => ({
  type: 'system',
  subtype: 'spine_cut',
  spineCutCount: count,
  spineSavedTokens: 1000 * count,
} as unknown as SDKMessage)

/** 复刻 AssistantTurnRenderer 的顶层块统计：排除子代理块之后的每轮 assistant 顶层块数。 */
function topLevelBlockCounts(turn: AssistantTurn): number[] {
  return turn.assistantMessages.map((message) => {
    const content = message.message?.content
    return Array.isArray(content) ? content.length : 0
  })
}

function entryKinds(item: { entries: ReadonlyArray<{ kind: string }>; }): string[] {
  return item.entries.map((entry) => (entry.kind === 'spine_cut' ? 'cut' : 'block'))
}

const transcript = jsonl([
  userText('调查压缩事件'),
  assistantTool('t1', 'bash'),
  toolResult('t1'),
  cut(1),
  assistantTool('t2', 'read'),
  toolResult('t2'),
  cut(2),
  assistantText('a3', '结论如下'),
  { type: 'result', subtype: 'success' } as unknown as SDKMessage,
])

describe('切割事件跨层落位', () => {
  test('Given 一轮内三次工具往返各切一刀 When 分组 Then 锚点落在对应工具行之后', () => {
    const groups = groupIntoTurns(readSessionMessagesFromString(transcript))
    const turn = groups.find((group) => group.type === 'assistant-turn')
    if (turn?.type !== 'assistant-turn') throw new Error('unreachable')

    // 隐含契约：turnMessages 里的 assistant 序列与 assistantMessages 同源同序
    const assistantsInTurnMessages = turn.turnMessages.filter((message) => message.type === 'assistant')
    expect(assistantsInTurnMessages).toHaveLength(turn.assistantMessages.length)

    const events = locateSpineCutEvents(turn.turnMessages, topLevelBlockCounts(turn), true)
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.blockIndex)).toEqual([1, 2])
  })

  test('Given 同一轮 When 渲染布局 Then 切割行插在对应工具行之间而不是堆到末尾', () => {
    const groups = groupIntoTurns(readSessionMessagesFromString(transcript))
    const turn = groups.find((group) => group.type === 'assistant-turn')
    if (turn?.type !== 'assistant-turn') throw new Error('unreachable')

    const blocks = turn.assistantMessages.flatMap(
      (message) => (message.message?.content ?? []) as SDKContentBlock[],
    )
    const events = locateSpineCutEvents(turn.turnMessages, topLevelBlockCounts(turn), true)
    const items = buildAssistantTurnRenderItems(blocks, { events })

    // 终态：最终回答块在前，过程组收尾；组内顺序为 工具行 → 切割 → 工具行 → 切割
    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut', 'block', 'cut'])
    const blockNames = group.entries
      .filter((entry) => entry.kind === 'block')
      .map((entry) => (entry.item.block as { name?: string }).name)
    expect(blockNames).toEqual(['bash', 'read'])
  })

  test('Given 显示关闭 When 跨层定位 Then 无切割行也不报错', () => {
    const groups = groupIntoTurns(readSessionMessagesFromString(transcript))
    const turn = groups.find((group) => group.type === 'assistant-turn')
    if (turn?.type !== 'assistant-turn') throw new Error('unreachable')

    expect(locateSpineCutEvents(turn.turnMessages, topLevelBlockCounts(turn), false)).toEqual([])
  })
})
