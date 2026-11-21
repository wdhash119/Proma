import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('交付物浮窗布局契约', () => {
  test('Given AgentMessages When 检查 Then 浮窗在 Conversation 滚动容器之外', () => {
    const source = readFileSync(join(import.meta.dir, 'AgentMessages.tsx'), 'utf8')
    const barIndex = source.indexOf('<AgentArtifactsBar')
    const conversationIndex = source.indexOf('<Conversation')
    expect(barIndex).toBeGreaterThan(-1)
    expect(conversationIndex).toBeGreaterThan(-1)
    // 浮窗必须先于 Conversation 出现（flex 兄弟），不得嵌入 StickToBottom 根容器内部
    expect(barIndex).toBeLessThan(conversationIndex)
  })

  test('Given ConversationContent When 检查 Then 滚动视口保持 height:100%（由父 flex 收缩决定可用高度）', () => {
    const source = readFileSync(join(import.meta.dir, '../ai-elements/conversation.tsx'), 'utf8')
    expect(source).toContain('min-h-0 flex-1 overflow-y-hidden')
  })
})