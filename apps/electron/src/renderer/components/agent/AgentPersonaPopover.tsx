/**
 * AgentPersonaPopover - Agent 输入栏人设选择弹层
 *
 * 与思考模式弹层并列的工具栏项：Bot 图标触发器（激活非默认人设时高亮），
 * 弹层列出人设库供会话级选择。选择持久化到 AgentSessionMeta.personaId，
 * 下一轮运行生效（系统提示词每轮重建，中途切换无需重建会话）。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Bot, Check, Settings, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { inputToolbarActiveButtonClass, inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { usePersonaConfig } from '@/hooks/usePersonaConfig'
import { resolveSessionPersona } from '@proma/shared'
import { cn } from '@/lib/utils'

interface AgentPersonaPopoverProps {
  /** 会话显式选择的人设 ID；undefined 表示使用人设库默认 */
  personaId: string | undefined
  onSelect: (personaId: string) => void
}

export function AgentPersonaPopover({ personaId, onSelect }: AgentPersonaPopoverProps): React.ReactElement {
  const config = usePersonaConfig()
  const [open, setOpen] = React.useState(false)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)

  const effectivePersona = resolveSessionPersona(config, personaId)
  const isCustomActive = effectivePersona !== undefined && effectivePersona.id !== config.defaultPersonaId
  const triggerLabel = effectivePersona ? `人设: ${effectivePersona.name}` : '选择人设'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(inputToolbarButtonClass, isCustomActive && inputToolbarActiveButtonClass)}
              aria-label={triggerLabel}
              aria-pressed={isCustomActive}
            >
              <Bot className="size-5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top"><p>{triggerLabel}</p></TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="center" sideOffset={8} className="w-72 p-2">
        <div className="px-2 py-1.5 text-xs font-medium text-foreground/80">
          会话人设
        </div>
        <ScrollArea className="max-h-64">
          <div className="space-y-0.5 pr-1">
            {config.personas.map((persona) => {
              const isSelected = persona.id === effectivePersona?.id
              return (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => {
                    onSelect(persona.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60',
                    isSelected && 'bg-accent/50'
                  )}
                >
                  <Check className={cn('size-4 shrink-0 mt-0.5', isSelected ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-foreground">{persona.name}</span>
                      {persona.builtin && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">(内置)</span>
                      )}
                      {persona.id === config.defaultPersonaId && (
                        <Star className="size-3 shrink-0 text-amber-500 fill-amber-500" />
                      )}
                    </span>
                    {persona.description && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{persona.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </ScrollArea>
        <div className="mt-1 border-t border-border/50 pt-1.5 px-2 space-y-1.5">
          <p className="text-[10px] text-muted-foreground">
            切换从下一轮生效；默认助手不额外注入 Agent 提示词。
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start text-xs text-muted-foreground"
            onClick={() => {
              setSettingsTab('personas')
              setSettingsOpen(true)
              setOpen(false)
            }}
          >
            <Settings className="size-3.5 mr-1.5" />
            管理人设…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}