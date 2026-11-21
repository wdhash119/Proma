import { describe, expect, test } from 'bun:test'
import { createQuickCaptureTrigger } from './quick-capture-trigger'

describe('清单快速捕获去重', () => {
  test('Given 全局 IPC 与本地 keydown 同轮到达 When 触发 Then 只打开一次', () => {
    let opens = 0
    let clock = 0
    const trigger = createQuickCaptureTrigger(() => { opens += 1 }, {
      now: () => clock,
      windowMs: 300,
    })

    expect(trigger()).toBe(true) // 主进程 IPC
    clock += 20
    expect(trigger()).toBe(false) // 本地 keydown
    expect(opens).toBe(1)
  })

  test('Given 超过去重窗口 When 再次触发 Then 正常打开', () => {
    let opens = 0
    let clock = 0
    const trigger = createQuickCaptureTrigger(() => { opens += 1 }, {
      now: () => clock,
      windowMs: 300,
    })

    expect(trigger()).toBe(true)
    clock += 299
    expect(trigger()).toBe(false)
    clock += 1
    expect(trigger()).toBe(true)
    expect(opens).toBe(2)
  })
})
