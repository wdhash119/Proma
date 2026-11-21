/**
 * 「关于你」设置页：全局画像与项目记忆的浏览、检索、历史版本与恢复。
 *
 * 写入由 Agent 的 MemoryUpdate 工具完成（带 revision 校验与历史快照），
 * 这里只读取与恢复，避免界面和 Agent 出现两套写入路径。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { History, RotateCcw, Search, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { MemoryDocumentPayload, MemoryRevisionItem, MemorySearchResultItem, MemoryTargetSummary } from '@proma/shared'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { Button } from '../ui/button'
import { Input } from '@/components/ui/input'
import { SettingsCard, SettingsSection } from './primitives'
import { cn } from '@/lib/utils'

const GLOBAL_PROFILE_TARGET = 'global-profile'

function formatTimestamp(value: number): string {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function AboutYouSettings(): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaceSlug = workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.slug

  const [targets, setTargets] = React.useState<MemoryTargetSummary[]>([])
  const [selectedTarget, setSelectedTarget] = React.useState<string>(GLOBAL_PROFILE_TARGET)
  const [document, setDocument] = React.useState<MemoryDocumentPayload | null>(null)
  const [history, setHistory] = React.useState<MemoryRevisionItem[]>([])
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<MemorySearchResultItem[]>([])
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const refresh = React.useCallback(() => setReloadToken((value) => value + 1), [])

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.listMemoryTargets(workspaceSlug).then((items) => {
      if (cancelled) return
      setTargets(items)
      // 工作区切换后原选中目标可能消失，回退到全局画像。
      if (!items.some((item) => item.target === selectedTarget)) {
        setSelectedTarget(GLOBAL_PROFILE_TARGET)
      }
    }).catch((error) => {
      console.error('[关于你] 读取记忆目标失败:', error)
    })
    return () => { cancelled = true }
    // selectedTarget 只在需要回退时读取，不触发重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, reloadToken])

  React.useEffect(() => {
    let cancelled = false
    Promise.all([
      window.electronAPI.readMemoryTarget(selectedTarget, workspaceSlug),
      window.electronAPI.listMemoryHistory(selectedTarget, workspaceSlug, 20),
    ]).then(([payload, revisions]) => {
      if (cancelled) return
      setDocument(payload)
      setHistory(revisions)
    }).catch((error) => {
      console.error('[关于你] 读取记忆内容失败:', error)
    })
    return () => { cancelled = true }
  }, [selectedTarget, workspaceSlug, reloadToken])

  const handleSearch = React.useCallback((value: string) => {
    setQuery(value)
    if (!value.trim()) {
      setHits([])
      return
    }
    window.electronAPI.searchMemory(value.trim(), workspaceSlug).then(setHits).catch((error) => {
      console.error('[关于你] 检索记忆失败:', error)
    })
  }, [workspaceSlug])

  const handleRestore = React.useCallback(async (revision: MemoryRevisionItem) => {
    if (!document || document.target !== revision.target) {
      toast.error('当前正文尚未加载完成，请稍后重试')
      return
    }
    setRestoringId(revision.id)
    try {
      // 带上读取时的 revision：若期间 Agent 又写了新内容，主进程会拒绝静默覆盖。
      await window.electronAPI.restoreMemoryRevision({
        target: revision.target,
        id: revision.id,
        expectedCurrentRevision: document.revision,
        workspaceSlug,
      })
      toast.success('已恢复到该历史版本')
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复历史版本失败')
    } finally {
      setRestoringId(null)
    }
  }, [document, refresh, workspaceSlug])

  const budget = document?.budgetChars
  const overBudget = !!budget && document.chars > budget

  return (
    <div className="space-y-6">
      <SettingsSection
        title="关于你"
        description="Proma 记住的与你有关的事实。写入由 Agent 完成，这里可以查看、检索和恢复历史版本。"
      >
        <SettingsCard divided={false} className="p-4">
          <div className="flex items-center gap-3">
            {userProfile.avatar
              ? <img src={userProfile.avatar} alt="" className="size-10 rounded-full object-cover" />
              : <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary"><Sparkles className="size-5" /></div>}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{userProfile.userName}</div>
              <div className="truncate text-xs text-muted-foreground">
                全局画像跨工作区共享；项目记忆只属于当前工作区
              </div>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="检索记忆"
        description="跨全局画像与项目记忆逐行检索，命中结果保留来源与行号"
      >
        <SettingsCard divided={false} className="p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(event) => handleSearch(event.target.value)}
              placeholder="例如：写作偏好 / Bun / 审稿"
              className="h-8 pl-8 text-[13px]"
            />
          </div>
          {hits.length > 0 && (
            <ul className="mt-3 space-y-1">
              {hits.map((hit, index) => (
                <li key={`${hit.target}:${hit.line}:${index}`} className="rounded-md bg-muted/35 px-2.5 py-1.5">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
                    <span className="truncate">{hit.source}</span>
                    <span className="tabular-nums">第 {hit.line} 行</span>
                  </div>
                  <div className="truncate text-[13px] text-foreground/85">{hit.text}</div>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && hits.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">没有命中任何记忆片段。</p>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="记忆内容" description="选择目标查看正文与历史版本">
        <SettingsCard divided={false} className="p-3">
          <div className="flex flex-wrap gap-1.5">
            {targets.map((item) => (
              <button
                key={item.target}
                type="button"
                onClick={() => setSelectedTarget(item.target)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs transition-colors',
                  item.target === selectedTarget
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {item.label}
                {item.kind === 'global-profile' && '（全局）'}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground/70">
            <span className="tabular-nums">{document?.chars ?? 0} 字</span>
            {budget && (
              <span className={cn('tabular-nums', overBudget && 'text-destructive')}>
                预算 {budget} 字{overBudget ? '（已超出）' : ''}
              </span>
            )}
            <span className="truncate">revision {document?.revision.slice(0, 8) ?? '-'}</span>
          </div>

          <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-muted/35 p-3 text-[13px] leading-6 whitespace-pre-wrap text-foreground/85">
            {document?.content.trim() || '（暂无内容）'}
          </pre>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="历史版本"
        description="每次写入都会保存改前的快照，恢复前的当前内容也会另存一份"
      >
        <SettingsCard divided={false} className="p-3">
          {history.length === 0 && (
            <p className="text-xs text-muted-foreground">还没有历史版本。Agent 改写记忆后会在这里出现。</p>
          )}
          <ul className="space-y-1">
            {history.map((revision) => (
              <li key={revision.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                <History className="size-3.5 shrink-0 text-muted-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
                  {revision.summary || '未填写说明'}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                  {formatTimestamp(revision.createdAt)}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                  {revision.chars} 字
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px]"
                  disabled={restoringId === revision.id}
                  onClick={() => { void handleRestore(revision) }}
                >
                  <RotateCcw className="size-3.5" />
                  {restoringId === revision.id ? '恢复中' : '恢复'}
                </Button>
              </li>
            ))}
          </ul>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
