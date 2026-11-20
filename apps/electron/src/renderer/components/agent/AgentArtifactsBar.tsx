/**
 * AgentArtifactsBar — 会话顶部的交付物区
 *
 * Agent 通过 `Present` 工具登记的最终成品集中显示在这里：默认收起为一行，
 * 展开后逐个文件可打开；源码、配置与临时脚本不会进入这个列表。
 */

import * as React from 'react'
import { ChevronRight, FileText, Package, Trash2 } from 'lucide-react'
import type { SessionArtifact } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface AgentArtifactsBarProps {
  sessionId: string
  /** 流式结束后再刷新，避免每个 token 都读一次文件。 */
  streaming: boolean
  /** 会话授权范围内的基础路径；打开交付物时用于路径校验。 */
  basePaths?: string[]
}

function takeFileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * 交付物只在轮次结束时可能变化：Present 一定在工具调用结束时完成，
 * 因此依赖 streaming 的下降沿刷新即可，不需要轮询。
 */
export function AgentArtifactsBar({ sessionId, streaming, basePaths }: AgentArtifactsBarProps): React.ReactElement | null {
  const [artifacts, setArtifacts] = React.useState<SessionArtifact[]>([])
  const [expanded, setExpanded] = React.useState(true)
  const [removing, setRemoving] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (streaming) return
    let cancelled = false
    window.electronAPI.listSessionArtifacts(sessionId).then((items) => {
      if (!cancelled) setArtifacts(items)
    }).catch((error) => {
      console.error('[交付物] 读取失败:', error)
    })
    return () => { cancelled = true }
  }, [sessionId, streaming])

  const handleOpen = React.useCallback((path: string) => {
    window.electronAPI.openFile(path, basePaths && basePaths.length > 0 ? { candidateBasePaths: basePaths } : undefined).catch((error) => {
      console.error('[交付物] 打开失败:', error)
    })
  }, [basePaths])

  const handleRemove = React.useCallback(async (path: string) => {
    setRemoving(path)
    try {
      const remaining = await window.electronAPI.removeSessionArtifact(sessionId, path)
      setArtifacts(remaining)
    } catch (error) {
      console.error('[交付物] 移除失败:', error)
    } finally {
      setRemoving(null)
    }
  }, [sessionId])

  if (artifacts.length === 0) return null

  return (
    <div className="mx-4 mb-1 mt-2 shrink-0 rounded-lg border border-border/60 bg-content-area/80">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-opacity hover:opacity-80"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        <Package className="size-3.5 shrink-0 text-primary/70" />
        <span className="text-[13px] font-medium text-foreground/85">交付物</span>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{artifacts.length}</span>
      </button>

      {expanded && (
        <ul className="space-y-1 px-3 pb-2">
          {artifacts.map((artifact) => (
            <li key={artifact.path} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
              <FileText className="size-3.5 shrink-0 text-muted-foreground/60" />
              <button
                type="button"
                onClick={() => handleOpen(artifact.path)}
                className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground/85 hover:text-primary"
                title={artifact.path}
              >
                {takeFileName(artifact.path)}
              </button>
              {artifact.description && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="hidden min-w-0 max-w-[40%] truncate text-[11px] text-muted-foreground/60 sm:inline">
                      {artifact.description}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{artifact.description}</TooltipContent>
                </Tooltip>
              )}
              <button
                type="button"
                aria-label="移除交付物"
                disabled={removing === artifact.path}
                onClick={() => { void handleRemove(artifact.path) }}
                className="shrink-0 rounded p-1 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
