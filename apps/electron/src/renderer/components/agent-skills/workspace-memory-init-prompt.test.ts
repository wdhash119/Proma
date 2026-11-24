import { describe, expect, test } from 'bun:test'
import { buildWorkspaceKnowledgeBootstrapPrompt } from './workspaceMemoryInitPrompt'

describe('协作画像建立引导提示词', () => {
  test('Given 用户启动建立协作知识 When 构建引导提示词 Then 协作画像写入 collaboration.md', () => {
    const prompt = buildWorkspaceKnowledgeBootstrapPrompt()

    expect(prompt).toContain('memory/collaboration.md')
    expect(prompt).not.toContain('memory/user-profile.md')
    expect(prompt).not.toContain('memory/user_profile.md')
  })
})
