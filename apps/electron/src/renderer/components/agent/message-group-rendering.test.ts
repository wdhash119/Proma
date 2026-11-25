import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { groupIntoTurns } from '@proma/session-core'
import { filterVisibleMessageGroups } from './message-group-rendering'

const orphanCut = {
  type: 'system',
  subtype: 'spine_cut',
  spineCutCount: 1,
} as SDKMessage

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
} as SDKMessage

describe('filterVisibleMessageGroups：独立 Live Compact 切割事件', () => {
  test('Given 独立切割与压缩状态 When 关闭显示 Then 只隐藏切割组', () => {
    const groups = groupIntoTurns([orphanCut, compactBoundary])

    expect(groups.map((group) => group.type)).toEqual(['system', 'system'])
    const visible = filterVisibleMessageGroups(groups, false)

    expect(visible).toHaveLength(1)
    expect(visible[0]?.type).toBe('system')
    if (visible[0]?.type !== 'system') throw new Error('unreachable')
    expect(visible[0].message.subtype).toBe('compact_boundary')
  })

  test('Given 独立切割与压缩状态 When 开启显示 Then 保留原分组数组', () => {
    const groups = groupIntoTurns([orphanCut, compactBoundary])

    expect(filterVisibleMessageGroups(groups, true)).toBe(groups)
  })

  test('Given 切割已归属 assistant turn When 关闭显示 Then 不丢弃整个回复分组', () => {
    const groups = groupIntoTurns([
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '继续' }] },
        parent_tool_use_id: null,
      } as SDKMessage,
      {
        type: 'assistant',
        message: { id: 'a1', content: [{ type: 'text', text: '完成' }] },
        parent_tool_use_id: null,
      } as SDKMessage,
      orphanCut,
    ])

    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn'])
    expect(filterVisibleMessageGroups(groups, false)).toEqual(groups)
  })
})
