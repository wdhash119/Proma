/**
 * ChatHistorySettings — 历史 Chat 归档页
 *
 * Chat 模式已退役，主入口统一为 Agent。历史对话仍可在本页检索、筛选、
 * 归档与逐条交给 Agent 继续；底层 conversations.json / JSONL 数据保持原样。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { Archive, Bot, ChevronLeft, ChevronRight, Loader2, Search, Trash2 } from 'lucide-react'
import type { ConversationMeta } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { SettingsSection } from './primitives'
import {
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { activeTabIdAtom, openTab, tabsAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'

type ArchiveFilter = 'active' | 'archived' | 'all'

const PAGE_SIZE = 20

const ARCHIVE_FILTERS: Array<{ value: ArchiveFilter; label: string }> = [
  { value: 'active', label: '活跃' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
]

function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ChatHistorySettings(): React.ReactElement {
  const store = useStore()
  const [conversations, setConversations] = React.useState<ConversationMeta[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState('')
  const [archiveFilter, setArchiveFilter] = React.useState<ArchiveFilter>('active')
  const [page, setPage] = React.useState(0)
  const [migratingId, setMigratingId] = React.useState<string | null>(null)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const loadConversations = React.useCallback(async () => {
    try {
      const list = await window.electronAPI.listConversations()
      setConversations(list)
    } catch (error) {
      console.error('[历史 Chat] 加载失败:', error)
      toast.error('加载历史 Chat 失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  const filtered = React.useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return conversations
      .filter((conversation) => {
        if (archiveFilter === 'active') return !conversation.archived
        if (archiveFilter === 'archived') return conversation.archived === true
        return true
      })
      .filter((conversation) => keyword.length === 0 || conversation.title.toLowerCase().includes(keyword))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations, archiveFilter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  React.useEffect(() => {
    setPage(0)
  }, [query, archiveFilter])

  const handleMigrate = React.useCallback(async (conversation: ConversationMeta): Promise<void> => {
    if (migratingId) return

    const agentChannelId = store.get(agentChannelIdAtom)
    if (!agentChannelId) {
      toast.error('请先在「模型配置」中启用 Agent 渠道')
      return
    }

    setMigratingId(conversation.id)
    try {
      const workspaces = store.get(agentWorkspacesAtom)
      const defaultWorkspaceId = workspaces[0]?.id ?? null
      const session = await window.electronAPI.createAgentSession(
        conversation.title,
        agentChannelId,
        defaultWorkspaceId ?? undefined,
        store.get(agentModelIdAtom) || undefined,
      )
      await window.electronAPI.migrateChatToAgent(conversation.id, session.id)

      const sessions = await window.electronAPI.listActiveAgentSessions()
      store.set(agentSessionsAtom, sessions)

      if (defaultWorkspaceId) {
        store.set(currentAgentWorkspaceIdAtom, defaultWorkspaceId)
        window.electronAPI.updateSettings({ agentWorkspaceId: defaultWorkspaceId }).catch(console.error)
      }

      store.set(activeViewAtom, 'conversations')
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, {
        type: 'agent',
        sessionId: session.id,
        title: session.title ?? conversation.title,
      })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      store.set(currentAgentSessionIdAtom, session.id)

      toast.success('已交给 Agent 继续', {
        description: '历史对话已迁移到新的 Agent 会话',
      })
    } catch (error) {
      console.error('[历史 Chat] 迁移失败:', error)
      toast.error('迁移到 Agent 失败')
    } finally {
      setMigratingId(null)
    }
  }, [migratingId, store])

  const handleDelete = React.useCallback(async (conversation: ConversationMeta): Promise<void> => {
    if (deletingId) return
    setDeletingId(conversation.id)
    try {
      await window.electronAPI.deleteConversation(conversation.id)
      setConversations((previous) => previous.filter((item) => item.id !== conversation.id))
      toast.success('已删除该历史对话')
    } catch (error) {
      console.error('[历史 Chat] 删除失败:', error)
      toast.error('删除失败')
    } finally {
      setDeletingId(null)
    }
  }, [deletingId])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="历史 Chat"
        description="Chat 模式已退役，所有对话统一在 Agent 中进行。历史对话可以搜索、筛选归档状态，或逐条交给 Agent 继续。"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题"
              className="h-9 w-full rounded-lg border border-border bg-content-area pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-content-area p-1">
            {ARCHIVE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setArchiveFilter(filter.value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  archiveFilter === filter.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在加载历史对话...
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 py-12 text-center text-sm text-muted-foreground">
            {conversations.length === 0 ? '还没有历史 Chat 对话' : '没有匹配的历史对话'}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {pageItems.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-3 bg-content-area px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{conversation.title}</span>
                      {conversation.archived && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          <Archive className="size-3" />
                          已归档
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{formatUpdatedAt(conversation.updatedAt)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0"
                    disabled={migratingId !== null}
                    onClick={() => { void handleMigrate(conversation) }}
                  >
                    {migratingId === conversation.id ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Bot className="mr-1.5 size-3.5" />
                    )}
                    交给 Agent
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    aria-label={`删除 ${conversation.title}`}
                    disabled={deletingId !== null}
                    onClick={() => { void handleDelete(conversation) }}
                  >
                    {deletingId === conversation.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>共 {filtered.length} 条 · 第 {currentPage + 1} / {pageCount} 页</span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label="上一页"
                  disabled={currentPage === 0}
                  onClick={() => setPage((previous) => Math.max(0, previous - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label="下一页"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage((previous) => Math.min(pageCount - 1, previous + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  )
}
