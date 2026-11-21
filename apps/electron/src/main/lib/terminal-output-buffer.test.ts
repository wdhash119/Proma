import { describe, expect, test } from 'bun:test'
import { appendTerminalOutput, type TerminalOutputBuffer } from './terminal-output-buffer'
import type { TerminalOutputEvent } from '@proma/shared'

function emptyBuffer(): TerminalOutputBuffer {
  return { output: '', sequence: 0, startOffset: 0, endOffset: 0 }
}

function event(data: string, sequence: number): TerminalOutputEvent {
  return { terminalId: 't1', data, sequence }
}

describe('终端回放缓冲', () => {
  test('Given 空缓冲 When 追加输出 Then 保留原文并推进序号与偏移', () => {
    const next = appendTerminalOutput(emptyBuffer(), event('hello\r\n', 1), 1_000)
    expect(next.output).toBe('hello\r\n')
    expect(next.sequence).toBe(1)
    expect(next.startOffset).toBe(0)
    expect(next.endOffset).toBe(7)
  })

  test('Given 容量充足 When 追加多批 Then 全量拼接', () => {
    let buffer = appendTerminalOutput(emptyBuffer(), event('aa\r\n', 1), 1_000)
    buffer = appendTerminalOutput(buffer, event('bb\r\n', 2), 1_000)
    expect(buffer.output).toBe('aa\r\nbb\r\n')
    expect(buffer.endOffset).toBe(8)
  })

  test('Given 超出容量 When 截断 Then 从行首开始重放，避免半个转义序列', () => {
    // 第一批含完整行与一个被截断的转义序列尾部
    let buffer = appendTerminalOutput(emptyBuffer(), event('line-one\r\n\x1b[3', 1), 1_000)
    // 第二批把总长推过容量上限，截断点落在 'line-one' 中间
    buffer = appendTerminalOutput(buffer, event('2mcolor\r\nline-two\r\n', 2), 20)
    expect(buffer.output.startsWith('line-one')).toBe(false)
    expect(buffer.output.startsWith('2mcolor')).toBe(false)
    // 保留内容从某个行首开始（首个 \n 之后）
    expect(buffer.output).toBe('line-two\r\n')
    expect(buffer.startOffset).toBe(buffer.endOffset - buffer.output.length)
  })

  test('Given 截断后无换行 When 追加 Then 不丢尾批数据', () => {
    let buffer = appendTerminalOutput(emptyBuffer(), event('aaaa\r\n', 1), 1_000)
    buffer = appendTerminalOutput(buffer, event('bbbb', 2), 6)
    // 截断后 retained='aa\r\nbbbb' 含换行 → 从行首保留 'bbbb'
    expect(buffer.output).toBe('bbbb')
    expect(buffer.sequence).toBe(2)
  })
})