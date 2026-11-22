/**
 * PersonaSelector - ChatHeader 人设下拉选择器
 *
 * ghost 按钮 + DropdownMenu 列表，与 Pin/Parallel 按钮风格统一。
 * 人设正文作为侧栏问答的 systemMessage；管理入口跳转设置「人设管理」。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot, Check, Star, Settings } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { defaultPersonaIdAtom } from '@/atoms/persona-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useConversationPersonaId } from '@/hooks/useConversationSettings'
import { usePersonaConfig } from '@/hooks/usePersonaConfig'
import { cn } from '@/lib/utils'

export function PersonaSelector(): React.ReactElement {
  const config = usePersonaConfig()
  const [selectedId, setSelectedId] = useConversationPersonaId()
  const defaultPersonaId = useAtomValue(defaultPersonaIdAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [open, setOpen] = React.useState(false)

  const selectedPersona = config.personas.find((item) => item.id === selectedId)
  const tooltipText = selectedPersona ? `人设: ${selectedPersona.name}` : '选择人设'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={tooltipText}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Bot className="size-4" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56 z-[60]">
        {config.personas.map((persona) => (
          <div
            key={persona.id}
            onClick={() => {
              setSelectedId(persona.id)
              setOpen(false)
            }}
            className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Check className={cn(
              'size-4 shrink-0',
              persona.id === selectedId ? 'opacity-100' : 'opacity-0'
            )} />
            <span className="flex-1 truncate">{persona.name}</span>
            {persona.builtin && (
              <span className="text-xs text-muted-foreground shrink-0">(内置)</span>
            )}
            {persona.id === defaultPersonaId && (
              <Star className="size-3 text-amber-500 fill-amber-500 shrink-0" />
            )}
          </div>
        ))}
        <DropdownMenuSeparator />
        <div
          onClick={() => {
            setSettingsTab('personas')
            setSettingsOpen(true)
            setOpen(false)
          }}
          className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="size-4" />
          <span>管理人设</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}