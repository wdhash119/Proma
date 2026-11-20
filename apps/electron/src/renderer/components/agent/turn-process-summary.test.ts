import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@proma/shared'
import { buildAssistantTurnRenderItems, buildProcessGroupToolNames } from './ProcessBlockGroup'

function text(value: string): SDKContentBlock {
  return { type: 'text', text: value } as unknown as SDKContentBlock
}

function thinking(value: string): SDKContentBlock {
  return { type: 'thinking', thinking: value } as unknown as SDKContentBlock
}

function toolUse(name: string): SDKContentBlock {
  return { type: 'tool_use', id: `tool-${name}`, name, input: {} } as unknown as SDKContentBlock
}

function itemTypes(blocks: SDKContentBlock[], options: { isStreaming?: boolean } = {}): string[] {
  return buildAssistantTurnRenderItems(blocks, options).map((item) => item.type)
}

describe('轮次布局：最终回复在前，过程摘要收尾', () => {
  test('Given 过程后跟最终回复 When 轮次结束 Then 最终回复独立在前、过程组收尾', () => {
    const blocks = [thinking('先想想'), toolUse('Bash'), text('最终答案')]

    expect(itemTypes(blocks)).toEqual(['block', 'process-group'])

    const items = buildAssistantTurnRenderItems(blocks)
    const last = items[items.length - 1]
    expect(last?.type).toBe('process-group')
    // 过程组只包含最终回复之前的内容，最终答案不会被折叠进去。
    if (last?.type === 'process-group') {
      expect(last.items.map((entry) => entry.block.type)).toEqual(['thinking', 'tool_use'])
    }
  })

  test('Given 流式中 When 仍在上文追加工具 Then 过程组在前、实时回答在后', () => {
    const blocks = [thinking('先想想'), toolUse('Bash'), text('正在回答')]

    expect(itemTypes(blocks, { isStreaming: true })).toEqual(['process-group', 'block'])
  })

  test('Given 只有最终回复 When 无工具调用 Then 不产生过程组', () => {
    expect(itemTypes([text('只有答案')])).toEqual(['block'])
  })

  test('Given 只有过程没有文字 When 轮次结束 Then 整轮收敛为一行过程摘要', () => {
    const blocks = [thinking('想'), toolUse('Read'), toolUse('Edit')]

    expect(itemTypes(blocks)).toEqual(['process-group'])
    expect(buildProcessGroupToolNames(blocks)).toEqual(['Read', 'Edit'])
  })

  test('Given 多段连续文字 When 轮次结束 Then 全部作为最终回复保留在过程摘要之前', () => {
    const blocks = [toolUse('Bash'), text('第一段'), text('第二段')]

    const items = buildAssistantTurnRenderItems(blocks)
    expect(items.map((item) => item.type)).toEqual(['block', 'block', 'process-group'])
  })
})
