import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { getOrCreateSelectionAgent } from './selection-agent-session'
import {
  getSelectionAgentSessionIdFromSidePanelTab,
  getSelectionAgentSidePanelTab,
} from '../atoms/agent-atoms'

function makeSession(id: string): AgentSessionMeta {
  return {
    id,
    title: '选区 Agent',
    channelId: 'channel-1',
    modelId: 'model-1',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('选区 Agent 会话创建', () => {
  test('Given 同一父会话并发首开 When 创建尚未完成 Then 共享同一个 Promise', async () => {
    let calls = 0
    let resolveSession!: (session: AgentSessionMeta) => void
    const pending = new Promise<AgentSessionMeta>((resolve) => { resolveSession = resolve })
    const create = (): Promise<AgentSessionMeta> => {
      calls += 1
      return pending
    }

    const first = getOrCreateSelectionAgent('parent-concurrent', create)
    const second = getOrCreateSelectionAgent('parent-concurrent', create)
    expect(second).toBe(first)
    expect(calls).toBe(1)

    resolveSession(makeSession('selection-1'))
    expect(await first).toBe(await second)
  })

  test('Given 首次创建失败 When 用户重试 Then 不复用已拒绝的 Promise', async () => {
    let calls = 0
    const create = (): Promise<AgentSessionMeta> => {
      calls += 1
      return calls === 1
        ? Promise.reject(new Error('expected failure'))
        : Promise.resolve(makeSession('selection-retry'))
    }

    await expect(getOrCreateSelectionAgent('parent-retry', create)).rejects.toThrow('expected failure')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await getOrCreateSelectionAgent('parent-retry', create)).id).toBe('selection-retry')
    expect(calls).toBe(2)
  })
})

describe('选区 Agent 右侧 Tab 标识', () => {
  test('Given 会话 ID When 生成并解析 Tab Then 保持可逆且不认领探索分支', () => {
    const tab = getSelectionAgentSidePanelTab('selection-42')
    expect(tab).toBe('selection-agent:selection-42')
    expect(getSelectionAgentSessionIdFromSidePanelTab(tab)).toBe('selection-42')
    expect(getSelectionAgentSessionIdFromSidePanelTab('exploration:selection-42')).toBeNull()
    expect(getSelectionAgentSessionIdFromSidePanelTab('files')).toBeNull()
  })
})
