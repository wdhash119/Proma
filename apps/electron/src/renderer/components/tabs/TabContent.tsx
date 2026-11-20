/**
 * TabContent — 标签内容渲染器
 *
 * 根据标签类型渲染 AgentView 或预览内容。
 * Chat 模式已退役，历史 chat 标签会给出可执行的恢复指引。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { tabsAtom } from '@/atoms/tab-atoms'
import { AgentView } from '@/components/agent'
import { PreviewTabContent } from '@/components/diff/PreviewTabContent'
import { TabErrorBoundary } from './TabErrorBoundary'

export interface TabContentProps {
  tabId: string
}

export function TabContent({ tabId }: TabContentProps): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)

  // [FLASH-DEBUG] 监控 tab 查找失败（说明 tabId 指向了不存在的标签）
  React.useEffect(() => {
    if (!tab) {
      console.warn(`[FLASH-DEBUG] TabContent: tab not found for tabId="${tabId}"`, { tabIds: tabs.map(t => t.id) })
    }
  }, [tab, tabId, tabs])

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        标签页不存在
      </div>
    )
  }

  if (tab.type === 'chat') {
    // Chat 模式已退役：旧标签不再渲染 ChatView，避免把已下线的界面重新带回主入口。
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <span>Chat 模式已退役</span>
        <span className="text-xs">历史对话可在「设置 → 历史 Chat」中检索并交给 Agent 继续。</span>
      </div>
    )
  }

  if (tab.type === 'preview') {
    return (
      <TabErrorBoundary key={tab.id} sessionId={tab.sessionId}>
        <PreviewTabContent sessionId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }

  return (
    <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
      <AgentView sessionId={tab.sessionId} />
    </TabErrorBoundary>
  )
}
