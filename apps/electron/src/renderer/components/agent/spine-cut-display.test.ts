/**
 * 「显示压缩事件」开关的渲染层纯函数：
 * - filterVisibleTopLevelBlocks：关闭时从顶层块排除 spine_recall（原文召回）工具行；
 * - buildSpineCutNoticeText：切割通知文案（段数 / 节省 token / 强制收尾标注）。
 *
 * 开关只影响显示，不影响切割行为与事件发射；这两个纯函数是渲染过滤的可测核心。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKSystemMessage } from '@proma/shared'
import { filterVisibleTopLevelBlocks } from './ProcessBlockGroup'
import { buildSpineCutNoticeText } from './SpineCutNotice'

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