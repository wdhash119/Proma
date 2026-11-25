/**
 * 「显示压缩事件」开关的渲染层纯函数：
 * - filterVisibleTopLevelBlocks：关闭时从顶层块排除 spine_recall（原文召回）工具行；
 * - collectSpineCutEvents：关闭时收集不到切割事件（实时与历史一并隐藏）；
 * - buildAssistantTurnRenderItems：切割事件进入执行过程组，与工具行同级；
 * - buildSpineCutNoticeText：切割通知文案（段数 / 节省 token / 强制收尾标注）。
 *
 * 开关只影响显示，不影响切割行为与事件发射；这些纯函数是渲染过滤的可测核心。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKMessage, SDKSystemMessage } from '@proma/shared'
import { buildAssistantTurnRenderItems, filterVisibleTopLevelBlocks } from './ProcessBlockGroup'
import { buildSpineCutNoticeText, collectSpineCutEvents } from './SpineCutNotice'

const recallBlock: SDKContentBlock = { type: 'tool_use', id: 'call-1', name: 'spine_recall', input: { ref: 'entry-42' } }
const readBlock: SDKContentBlock = { type: 'tool_use', id: 'call-2', name: 'read', input: { path: 'a.ts' } }
const textBlock: SDKContentBlock = { type: 'text', text: '最终答案' }

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

describe('collectSpineCutEvents：切割事件收集与开关过滤', () => {
  const cut1: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 1 }
  const cut2: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 2, spineDrain: true }
  const messages = [
    { type: 'assistant', message: { content: [textBlock] }, parent_tool_use_id: null },
    cut1,
    { type: 'system', subtype: 'task_progress' },
    cut2,
    { type: 'result', subtype: 'success' },
  ] as unknown as SDKMessage[]

  test('Given 显示开启 When 收集 Then 按时间顺序返回全部切割事件', () => {
    expect(collectSpineCutEvents(messages, true)).toEqual([cut1, cut2])
  })

  test('Given 显示关闭 When 收集 Then 返回空数组（实时与历史一并隐藏）', () => {
    expect(collectSpineCutEvents(messages, false)).toEqual([])
  })

  test('Given 无切割事件 When 收集 Then 返回空数组', () => {
    expect(collectSpineCutEvents(messages.filter((message) => message !== cut1 && message !== cut2), true)).toEqual([])
  })
})

describe('buildAssistantTurnRenderItems：切割事件进入执行过程流', () => {
  const cut: SDKSystemMessage = { type: 'system', subtype: 'spine_cut', spineCutCount: 1, spineSavedTokens: 100 }

  test('Given 过程块加切割事件 When 构建 Then 事件与工具块同属一个过程组', () => {
    const items = buildAssistantTurnRenderItems([readBlock], { events: [cut] })

    expect(items).toHaveLength(1)
    const group = items[0]!
    expect(group.type).toBe('process-group')
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.items.map((entry) => entry.block)).toEqual([readBlock])
    expect(group.events).toEqual([cut])
  })

  test('Given 只有切割事件 When 构建 Then 仍产出过程组，避免事件丢失', () => {
    const items = buildAssistantTurnRenderItems([], { events: [cut] })

    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.items).toEqual([])
    expect(group.events).toEqual([cut])
  })

  test('Given 无切割事件 When 构建 Then 过程组不带事件（既有布局不变）', () => {
    const items = buildAssistantTurnRenderItems([readBlock])

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.events).toEqual([])
  })

  test('Given 终态含最终回答与切割事件 When 构建 Then 事件随过程组排在最终回答之后', () => {
    const items = buildAssistantTurnRenderItems([readBlock, textBlock], { events: [cut] })

    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.events).toEqual([cut])
  })

  test('Given 整轮只有最终回答与切割事件 When 构建 Then 事件仍有过程组承载', () => {
    const items = buildAssistantTurnRenderItems([textBlock], { events: [cut] })

    expect(items.map((item) => item.type)).toEqual(['block', 'process-group'])
    const group = items[1]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.items).toEqual([])
    expect(group.events).toEqual([cut])
  })

  test('Given 显示关闭 When 构建 Then 既无 spine_recall 也无切割事件', () => {
    const blocks = filterVisibleTopLevelBlocks([readBlock, recallBlock], false)
    const items = buildAssistantTurnRenderItems(blocks, { events: collectSpineCutEvents([], false) })

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.items.map((entry) => entry.block)).toEqual([readBlock])
    expect(group.events).toEqual([])
  })

  test('Given 显示开启 When 构建 Then spine_recall 作为普通工具行进入同一过程组', () => {
    const blocks = filterVisibleTopLevelBlocks([readBlock, recallBlock], true)
    const items = buildAssistantTurnRenderItems(blocks)

    const group = items[0]!
    if (group.type !== 'process-group') throw new Error('unreachable')
    expect(group.items.map((entry) => entry.block)).toEqual([readBlock, recallBlock])
  })
})
