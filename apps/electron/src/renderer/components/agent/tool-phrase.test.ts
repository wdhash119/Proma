import { describe, expect, test } from 'bun:test'
import { getToolPhrase } from './tool-phrase'

/** 测试用 36 位 UUID，用于模拟协作委派 ID 这类长标识符。 */
const CHANNEL_UUID = '00d0eb37-1f3e-4a45-9a3c-6bdbb0f9f1a2'

describe('工具短语字符上限', () => {
  test('Given 协作委派携带 36 位 UUID When 生成短语 Then 完整保留 UUID 且不加省略号', () => {
    const phrase = getToolPhrase('mcp__collaboration__delegate_agent', {
      channelId: CHANNEL_UUID,
      task: '实现登录页面',
    })

    expect(phrase.label).toContain(CHANNEL_UUID)
    expect(phrase.label).not.toContain('…')
  })

  test('Given 200 字符 Bash 命令 When 生成短语 Then 不再按 96 字符提前截断', () => {
    const command = `echo ${'a'.repeat(195)}`
    const phrase = getToolPhrase('Bash', { command })

    expect(phrase.label.length).toBeGreaterThan(96)
    expect(phrase.label).toContain(command)
    expect(phrase.label).not.toContain('…')
  })

  test('Given 超过 256 字符的命令 When 生成短语 Then 仍兜底截断并追加省略号', () => {
    const command = 'b'.repeat(300)
    const phrase = getToolPhrase('Bash', { command })

    expect(phrase.label).toContain('…')
    expect(phrase.label).not.toContain(command)
  })
})
