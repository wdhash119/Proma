/**
 * 「显示压缩事件」开关与切割事件定位的渲染层纯函数：
 * - filterVisibleTopLevelBlocks：关闭时从顶层块排除 spine_recall（原文召回）工具行；
 * - locateSpineCutEvents：把切割事件定位到它实际发生的顶层块锚点（关闭时返回空数组）；
 * - buildAssistantTurnRenderItems：切割行按锚点插回内容块之间，并按最终回答分侧；
 * - buildSpineCutNoticeText：切割通知文案（段数 / 节省 token / 强制收尾标注）。
 *
 * 回归背景：切割事件原先被整批追加到过程流末尾，看起来「堆在信息流末端」，
 * 而不是像工具调用那样停在它发生的位置。这些纯函数是定位与布局的可测核心。
 * 开关只影响显示，不影响切割行为与事件发射。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKMessage, SDKSystemMessage } from '@proma/shared'
import { buildAssistantTurnRenderItems, filterVisibleTopLevelBlocks } from './ProcessBlockGroup'
import { buildSpineCutNoticeText, locateSpineCutEvents } from './SpineCutNotice'

const recallBlock: SDKContentBlock = { type: 'tool_use', id: 'call-1', name: 'spine_recall', input: { ref: 'entry-42' } }
const readBlock: SDKContentBlock = { type: 'tool_use', id: 'call-2', name: 'read', input: { path: 'a.ts' } }
const bashBlock: SDKContentBlock = { type: 'tool_use', id: 'call-3', name: 'bash', input: { command: 'ls' } }
const grepBlock: SDKContentBlock = { type: 'tool_use', id: 'call-4', name: 'grep', input: { pattern: 'x' } }
const textBlock: SDKContentBlock = { type: 'text', text: '最终答案' }

/** 过程组条目的可读形态：'block' 或 'cut'，用于断言交织顺序。 */
function entryKinds(item: { entries: ReadonlyArray<{ kind: string }> }): string[] {
  return item.entries.map((entry) => (entry.kind === 'spine_cut' ? 'cut' : 'block'))
}

function entryBlocks(item: { entries: ReadonlyArray<{ kind: string; item?: { block: SDKContentBlock } }> }): SDKContentBlock[] {
  return item.entries
    .filter((entry) => entry.kind === 'block')
    .map((entry) => entry.item!.block)
}

describe('filterVisibleTopLevelBlocks：原文召回行过滤', () => {
  test('Given 显示开启 When 过滤 Then 原样返回（含 spine_recall，引用不变）', () => {
    const blocks = [readBlock, recallBlock, textBlock]
    expect(filterVisibleTopLevelBlocks(blocks, true)).toBe(blocks)
  })

  test('Given 显示关闭 When 过滤 Then 排除 spine_recall 但保留其它工具与文本', () => {
    const blocks = [readBlock, recallBlock, textBlock]
    const visible = filterVisibleTopLevelBlocks(blocks, false)
    expect(visible).toEqual([readBlock, textBlock])
    expect(visible.some((block) => block.type === 'tool_use' && block.name === 'spine_recall')).toBe(false)
  })

  test('Given 显示关闭且无召回 When 过滤 Then 内容不变', () => {
    const blocks = [readBlock, textBlock]
    expect(filterVisibleTopLevelBlocks(blocks, false)).toEqual(blocks)
  })

  test('Given 空块列表 When 过滤 Then 仍为空', () => {
    expect(filterVisibleTopLevelBlocks([], false)).toEqual([])
    expect(filterVisibleTopLevelBlocks([], true)).toEqual([])
  })
})

describe('端到端定位：工具往返之间发生的切割不再堆到过程末尾', () => {
  /** 复刻一轮真实节奏：三次工具往返，每次 turn_end 各切一刀。 */
  const toolRoundTrip = (toolUseId: string): SDKMessage[] => [
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
  ]
  const assistantRound = (block: SDKContentBlock): SDKMessage => ({
    type: 'assistant',
    message: { content: [block] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

  const turnMessages = [
    assistantRound(bashBlock),
    ...toolRoundTrip('call-3'),
    { type: 'system', subtype: 'spine_cut', spineCutCount: 1 },
    assistantRound(readBlock),
    ...toolRoundTrip('call-2'),
    { type: 'system', subtype: 'spine_cut', spineCutCount: 2 },
    assistantRound(grepBlock),
    ...toolRoundTrip('call-4'),
    { type: 'system', subtype: 'spine_cut', spineCutCount: 3 },
    { type: 'result', subtype: 'success' },
  ] as unknown as SDKMessage[]
  // 每条 assistant 消息只贡献 1 个顶层块（tool_result 在渲染层不形成顶层块）。
  const topLevelBlockCountsByAssistant = [1, 1, 1]

  test('Given 三次往返各切一刀 When 定位 Then 锚点依次为 1、2、3', () => {
    const events = locateSpineCutEvents(turnMessages, topLevelBlockCountsByAssistant, true)
    expect(events.map((event) => event.blockIndex)).toEqual([1, 2, 3])
  })

  test('Given 上述锚点 When 构建渲染项 Then 切割行紧跟对应的工具行而不是堆成一摘', () => {
    const events = locateSpineCutEvents(turnMessages, topLevelBlockCountsByAssistant, true)
    const items = buildAssistantTurnRenderItems([bashBlock, readBlock, grepBlock], { events })

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut', 'block', 'cut', 'block', 'cut'])
    expect(entryBlocks(group)).toEqual([bashBlock, readBlock, grepBlock])
  })
})

describe('buildSpineCutNoticeText：切割通知文案', () => {
  test('Given 段数与节省 When 生成 Then 含中文段数与本地化 token 数', () => {
    const message: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 2, spineSavedTokens: 12345 }
    expect(buildSpineCutNoticeText(message)).toBe(`Spine 压缩：切下 2 段，节省约 ${(12345).toLocaleString()} tokens`)
  })

  test('Given drain=true When 生成 Then 追加强制收尾标注', () => {
    const message: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 1, spineSavedTokens: 800, spineDrain: true }
    expect(buildSpineCutNoticeText(message)).toBe(`Spine 压缩：切下 1 段，节省约 ${(800).toLocaleString()} tokens（强制收尾）`)
  })

  test('Given 只有节省没有段数 When 生成 Then 只显示节省', () => {
    const message: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineSavedTokens: 500 }
    expect(buildSpineCutNoticeText(message)).toBe(`Spine 压缩：节省约 ${(500).toLocaleString()} tokens`)
  })

  test('Given 字段缺失或非法 When 生成 Then 回落通用文案不渲染空数字', () => {
    expect(buildSpineCutNoticeText({ type: 'system', subtype: 'spine_cut' })).toBe('Spine 压缩：上下文已就地压缩')
    expect(buildSpineCutNoticeText({ type: 'system', subtype: 'spine_cut', spineCutCount: 0, spineSavedTokens: -3 })).toBe('Spine 压缩：上下文已就地压缩')
  })
})

describe('locateSpineCutEvents：切割事件定位到顶层块锚点', () => {
  const cut1: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 1 }
  const cut2: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 2, spineDrain: true }
  const assistantWithTwoBlocks = {
    type: 'assistant',
    message: { content: [bashBlock, readBlock] },
    parent_tool_use_id: null,
  }
  const assistantWithOneBlock = {
    type: 'assistant',
    message: { content: [grepBlock] },
    parent_tool_use_id: null,
  }
  const turnMessages = [
    assistantWithTwoBlocks,
    cut1,
    { type: 'system', subtype: 'task_progress' },
    assistantWithOneBlock,
    cut2,
    { type: 'result', subtype: 'success' },
  ] as unknown as SDKMessage[]

  test('Given 两条 assistant 分别贡献 2、1 个顶层块 When 定位 Then 锚点为其前累计块数', () => {
    expect(locateSpineCutEvents(turnMessages, [2, 1], true)).toEqual([
      { message: cut1, blockIndex: 2 },
      { message: cut2, blockIndex: 3 },
    ])
  })

  test('Given 显示关闭 When 定位 Then 返回空数组（实时与历史一并隐藏）', () => {
    expect(locateSpineCutEvents(turnMessages, [2, 1], false)).toEqual([])
  })

  test('Given 无切割事件 When 定位 Then 返回空数组', () => {
    const withoutCuts = turnMessages.filter((message) => message !== cut1 && message !== cut2)
    expect(locateSpineCutEvents(withoutCuts, [2, 1], true)).toEqual([])
  })

  test('Given 计数少于 assistant 消息数 When 定位 Then 缺失项按 0 计不越界', () => {
    expect(locateSpineCutEvents(turnMessages, [2], true)).toEqual([
      { message: cut1, blockIndex: 2 },
      { message: cut2, blockIndex: 2 },
    ])
  })

  test('Given 切割发生在任何块之前 When 定位 Then 锚点为 0', () => {
    const messages = [cut1, assistantWithOneBlock] as unknown as SDKMessage[]
    expect(locateSpineCutEvents(messages, [1], true)).toEqual([{ message: cut1, blockIndex: 0 }])
  })
})

describe('buildAssistantTurnRenderItems：切割行按锚点插回内容块之间', () => {
  const cutEarly: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 1 }
  const cutLate: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 2 }

  test('Given 三次工具调用与两个锚点 When 构建 Then 切割行落在对应工具行之间而非末尾', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, readBlock, grepBlock], {
      events: [
        { message: cutEarly, blockIndex: 1 },
        { message: cutLate, blockIndex: 3 },
      ],
    })

    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut', 'block', 'block', 'cut'])
    expect(entryBlocks(group)).toEqual([bashBlock, readBlock, grepBlock])
  })

  test('Given 多个切割同锚点 When 构建 Then 按调用方给出的先后顺序连续插入', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, readBlock], {
      events: [
        { message: cutLate, blockIndex: 1 },
        { message: cutEarly, blockIndex: 1 },
      ],
    })

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut', 'cut', 'block'])
    // 同锚点不重排（sort 稳定），保留事件发射先后
    expect(group.events.map((event) => event.message)).toEqual([cutLate, cutEarly])
  })

  test('Given 只有切割事件 When 构建 Then 仍产出过程组承载切割行', () => {
    const items = buildAssistantTurnRenderItems([], { events: [{ message: cutEarly, blockIndex: 0 }] })

    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['cut'])
    expect(group.events).toHaveLength(1)
  })

  test('Given 无切割事件 When 构建 Then 过程组不带事件（既有布局不变）', () => {
    const items = buildAssistantTurnRenderItems([readBlock])

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.events).toEqual([])
    expect(entryKinds(group)).toEqual(['block'])
  })

  test('Given 终态有最终回答且切割发生在回答之前 When 构建 Then 切割留在过程组内、排在工具行之后', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, readBlock, textBlock], {
      events: [{ message: cutEarly, blockIndex: 1 }],
    })

    // 终态阅读顺序：最终回答在前，过程摘要收尾
    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut', 'block'])
    expect(entryBlocks(group)).toEqual([bashBlock, readBlock])
  })

  test('Given 终态切割发生在最终回答之后 When 构建 Then 并入过程组末尾不另起一组', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, textBlock], {
      events: [{ message: cutLate, blockIndex: 2 }],
    })

    // 终态下过程组整体已排在回答之后，组末尾就是该切割的正确位置
    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut'])
    expect(entryBlocks(group)).toEqual([bashBlock])
  })

  test('Given 切割分居最终回答两侧 When 终态构建 Then 同组内按锚点先后排列', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, textBlock], {
      events: [
        { message: cutEarly, blockIndex: 1 },
        { message: cutLate, blockIndex: 2 },
      ],
    })

    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const processGroup = items[1]!
    if (processGroup.type !== 'process-group') throw new Error('unreachable')
    // 工具行之间、工具行之后各一行，而不是堆成一摘
    expect(entryKinds(processGroup)).toEqual(['block', 'cut', 'cut'])
    expect(entryBlocks(processGroup)).toEqual([bashBlock])
  })

  test('Given 流式过程与实时回答且切割在回答之后 When 构建 Then 切割另起收尾到回答下方', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, textBlock], {
      isStreaming: true,
      events: [{ message: cutLate, blockIndex: 2 }],
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block', 'process-group'])
    const processGroup = items[0]!
    const tailGroup = items[2]!
    if (processGroup.type !== 'process-group' || tailGroup.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(processGroup)).toEqual(['block'])
    expect(entryKinds(tailGroup)).toEqual(['cut'])
    // 两个过程组在同一兄弟列表中必须有稳定且不同的 React key。
    const groupKeys = items.flatMap((item) => (item.type === 'process-group' ? [item.groupKey] : []))
    expect(groupKeys).toEqual(['process-main', 'process-tail'])
    expect(new Set(groupKeys).size).toBe(groupKeys.length)
  })

  test('Given 只有最终回答且切割分居两侧 When 流式构建 Then 前后过程组 key 不冲突', () => {
    const items = buildAssistantTurnRenderItems([textBlock], {
      isStreaming: true,
      events: [
        { message: cutEarly, blockIndex: 0 },
        { message: cutLate, blockIndex: 1 },
      ],
    })

    const groupKeys = items.flatMap((item) => (item.type === 'process-group' ? [item.groupKey] : []))
    expect(groupKeys).toEqual(['process-main', 'process-tail'])
    expect(new Set(groupKeys).size).toBe(groupKeys.length)
  })

  test('Given 流式过程与实时回答 When 构建 Then 过程在上回答在下、切割留在过程内', () => {
    const items = buildAssistantTurnRenderItems([bashBlock, textBlock], {
      isStreaming: true,
      events: [{ message: cutEarly, blockIndex: 1 }],
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['block', 'cut'])
  })

  test('Given 整轮只有最终回答且切割在其之前 When 构建 Then 切割按时间排在回答之前', () => {
    const items = buildAssistantTurnRenderItems([textBlock], {
      events: [{ message: cutEarly, blockIndex: 0 }],
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['cut'])
  })

  test('Given 整轮只有最终回答且切割在其之后 When 构建 Then 切割收尾在回答之后', () => {
    const items = buildAssistantTurnRenderItems([textBlock], {
      events: [{ message: cutLate, blockIndex: 1 }],
    })

    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryKinds(group)).toEqual(['cut'])
  })

  test('Given 显示关闭 When 构建 Then 既无 spine_recall 也无切割行', () => {
    const blocks = filterVisibleTopLevelBlocks([readBlock, recallBlock], false)
    const items = buildAssistantTurnRenderItems(blocks, { events: locateSpineCutEvents([], [], false) })

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryBlocks(group)).toEqual([readBlock])
    expect(group.events).toEqual([])
  })

  test('Given 显示开启 When 构建 Then spine_recall 作为普通工具行进入同一过程组', () => {
    const blocks = filterVisibleTopLevelBlocks([readBlock, recallBlock], true)
    const items = buildAssistantTurnRenderItems(blocks)

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(entryBlocks(group)).toEqual([readBlock, recallBlock])
  })
})
