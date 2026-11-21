/**
 * PersonaSettings - 人设管理设置页
 *
 * 参考 pi-app 人设管理的 master-detail 形态：
 * 左侧人设库列表（默认/内置徽章 + token 估算），右侧编辑器（名称/说明/正文/示范对话）。
 * 人设供 Agent 系统提示词注入与侧栏问答 systemMessage 共用；默认人设用于新会话。
 * 内置人设只读；自定义人设防抖自动保存；支持 Markdown 导入导出（pi-app 格式兼容）。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus, Trash2, Star, Download, Upload, Bot } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsCard } from './primitives'
import { personaConfigAtom, defaultPersonaIdAtom } from '@/atoms/persona-atoms'
import { usePersonaConfig } from '@/hooks/usePersonaConfig'
import { MAX_PRIMER_TURNS } from '@proma/shared'
import type { Persona, PersonaPrimerTurn, PersonaUpdateInput } from '@proma/shared'

/** 防抖保存延迟 (ms) */
const DEBOUNCE_DELAY = 500

/** 粗估 token 数（中文约 1.6 字符/token，英文约 4 字符/token，取折中） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2)
}

export function PersonaSettings(): React.ReactElement {
  const config = usePersonaConfig()
  const setConfig = useSetAtom(personaConfigAtom)
  const defaultPersonaId = useAtomValue(defaultPersonaIdAtom)

  const [selectedId, setSelectedId] = React.useState<string>(config.defaultPersonaId)
  const [editName, setEditName] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')
  const [editBody, setEditBody] = React.useState('')
  const [editPrimer, setEditPrimer] = React.useState<PersonaPrimerTurn[]>([])
  const [hoveredId, setHoveredId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = React.useRef<{ id: string; input: PersonaUpdateInput } | null>(null)

  const selectedPersona = React.useMemo(
    () => config.personas.find((persona) => persona.id === selectedId),
    [config.personas, selectedId]
  )

  /** 选中人设变化时同步编辑字段 */
  React.useEffect(() => {
    if (selectedPersona) {
      setEditName(selectedPersona.name)
      setEditDescription(selectedPersona.description)
      setEditBody(selectedPersona.body)
      setEditPrimer(selectedPersona.primerTurns ?? [])
    }
  }, [selectedPersona])

  /** 执行一次保存（更新主进程与共享 atom） */
  const performSave = React.useCallback(async (id: string, input: PersonaUpdateInput): Promise<void> => {
    try {
      const updated = await window.electronAPI.updatePersona(id, input)
      setConfig((prev) => ({
        ...prev,
        personas: prev.personas.map((persona) => (persona.id === updated.id ? updated : persona)),
      }))
    } catch (error) {
      console.error('[人设设置] 保存失败:', error)
      toast.error('人设保存失败')
    }
  }, [setConfig])

  /** 立即落盘尚未保存的编辑（切换选中/卸载前调用，避免丢字） */
  const flushSave = React.useCallback((): void => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    if (pending) void performSave(pending.id, pending.input)
  }, [performSave])

  /** 卸载时落盘未保存编辑 */
  React.useEffect(() => flushSave, [flushSave])

  /** 防抖自动保存（仅自定义人设） */
  const scheduleSave = React.useCallback((input: PersonaUpdateInput): void => {
    if (!selectedPersona || selectedPersona.builtin) return
    pendingSaveRef.current = { id: selectedPersona.id, input: { ...pendingSaveRef.current?.input, ...input } }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const pending = pendingSaveRef.current
      pendingSaveRef.current = null
      debounceRef.current = null
      if (pending) void performSave(pending.id, pending.input)
    }, DEBOUNCE_DELAY)
  }, [selectedPersona, performSave])

  const handleSelect = (id: string): void => {
    if (id === selectedId) return
    flushSave()
    setSelectedId(id)
  }

  const handleCreate = async (): Promise<void> => {
    flushSave()
    try {
      const created = await window.electronAPI.createPersona({ name: '新人设', body: '' })
      setConfig((prev) => ({ ...prev, personas: [...prev.personas, created] }))
      setSelectedId(created.id)
    } catch (error) {
      console.error('[人设设置] 创建失败:', error)
      toast.error('创建人设失败')
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    flushSave()
    try {
      await window.electronAPI.deletePersona(id)
      setConfig((prev) => {
        const personas = prev.personas.filter((persona) => persona.id !== id)
        const nextDefault = prev.defaultPersonaId === id ? 'builtin-default' : prev.defaultPersonaId
        return { ...prev, personas, defaultPersonaId: nextDefault }
      })
      if (selectedId === id) setSelectedId('builtin-default')
    } catch (error) {
      console.error('[人设设置] 删除失败:', error)
      toast.error('删除人设失败')
    }
  }

  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.setDefaultPersona(id)
      setConfig((prev) => ({ ...prev, defaultPersonaId: id }))
    } catch (error) {
      console.error('[人设设置] 设置默认失败:', error)
      toast.error('设置默认人设失败')
    }
  }

  const handleImport = async (): Promise<void> => {
    flushSave()
    setBusy(true)
    try {
      const result = await window.electronAPI.importPersonaMarkdown()
      if (!result.success) {
        if (result.message && result.message !== '已取消导入') toast.error(result.message)
        return
      }
      const cfg = await window.electronAPI.getPersonaConfig()
      setConfig(cfg)
      if (result.persona) setSelectedId(result.persona.id)
      toast.success(`已导入人设「${result.persona?.name ?? ''}」`)
    } catch (error) {
      console.error('[人设设置] 导入失败:', error)
      toast.error('导入人设失败')
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (!selectedPersona) return
    flushSave()
    setBusy(true)
    try {
      const result = await window.electronAPI.exportPersonaMarkdown(selectedPersona.id)
      if (!result.success) {
        if (result.message && result.message !== '已取消导出') toast.error(result.message)
        return
      }
      toast.success('已导出 Markdown')
    } catch (error) {
      console.error('[人设设置] 导出失败:', error)
      toast.error('导出人设失败')
    } finally {
      setBusy(false)
    }
  }

  const isReadonly = selectedPersona?.builtin === true

  const updatePrimer = (next: PersonaPrimerTurn[]): void => {
    setEditPrimer(next)
    scheduleSave({ primerTurns: next })
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="人设库"
        description="人设定义 Agent 与侧栏问答的角色和风格：正文注入系统提示词，示范对话作为请求前缀。默认人设用于新会话；「Proma 默认助手」是问答基线，Agent 不额外注入。"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void handleImport()} disabled={busy}>
              <Upload className="size-4 mr-1" />
              导入
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={busy}>
              <Plus className="size-4 mr-1" />
              新建
            </Button>
          </div>
        }
      >
        <SettingsCard divided={false} className="p-0">
          <div className="grid grid-cols-1 md:grid-cols-[240px_1fr]">
            {/* 左：人设列表 */}
            <div className="border-b md:border-b-0 md:border-r border-border/50 max-h-[560px] overflow-y-auto">
              <div className="divide-y divide-border/50">
                {config.personas.map((persona) => (
                  <PersonaListItem
                    key={persona.id}
                    persona={persona}
                    isSelected={persona.id === selectedId}
                    isDefault={persona.id === defaultPersonaId}
                    isHovered={persona.id === hoveredId}
                    onSelect={handleSelect}
                    onDelete={handleDelete}
                    onSetDefault={handleSetDefault}
                    onHoverChange={setHoveredId}
                  />
                ))}
              </div>
            </div>

            {/* 右：编辑器 */}
            {selectedPersona ? (
              <div className="p-4 space-y-3 min-w-0">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">{selectedPersona.name}</span>
                  {selectedPersona.builtin && (
                    <span className="text-xs text-muted-foreground shrink-0">内置 · 只读</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground shrink-0">
                    约 {estimateTokens(editBody)} tokens
                  </span>
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">名称</label>
                  <Input
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value)
                      scheduleSave({ name: e.target.value })
                    }}
                    readOnly={isReadonly}
                    className={cn(isReadonly && 'opacity-60 cursor-not-allowed')}
                    maxLength={50}
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">简短说明</label>
                  <Input
                    value={editDescription}
                    onChange={(e) => {
                      setEditDescription(e.target.value)
                      scheduleSave({ description: e.target.value })
                    }}
                    readOnly={isReadonly}
                    className={cn(isReadonly && 'opacity-60 cursor-not-allowed')}
                    placeholder="列表展示用的一句话说明"
                    maxLength={120}
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">人设正文（Markdown）</label>
                  <Textarea
                    value={editBody}
                    onChange={(e) => {
                      setEditBody(e.target.value)
                      scheduleSave({ body: e.target.value })
                    }}
                    readOnly={isReadonly}
                    className={cn(
                      'min-h-[280px] resize-y font-mono text-xs leading-relaxed',
                      isReadonly && 'opacity-60 cursor-not-allowed'
                    )}
                    placeholder="定义角色、语气与协作风格，例如：你是一名严谨的工程协作者……"
                  />
                </div>

                {/* 示范对话编辑器 */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm font-medium text-foreground">
                      示范对话（可选，≤{MAX_PRIMER_TURNS} 轮）
                    </label>
                    {!isReadonly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={editPrimer.length >= MAX_PRIMER_TURNS}
                        onClick={() => updatePrimer([...editPrimer, { role: 'user', content: '' }, { role: 'assistant', content: '' }])}
                      >
                        <Plus className="size-3.5 mr-1" />
                        添加一对
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    注入在系统提示词之后、真实历史之前的静态示范轮，让模型提前看到期望的应答风格；留空的轮次会被忽略。
                  </p>
                  {editPrimer.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                      暂无示范对话
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {editPrimer.map((turn, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <Select
                            value={turn.role}
                            disabled={isReadonly}
                            onValueChange={(value) => {
                              const next = [...editPrimer]
                              next[index] = { ...turn, role: value as PersonaPrimerTurn['role'] }
                              updatePrimer(next)
                            }}
                          >
                            <SelectTrigger className="w-28 h-8 text-xs shrink-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="user">用户</SelectItem>
                              <SelectItem value="assistant">助手</SelectItem>
                            </SelectContent>
                          </Select>
                          <Textarea
                            value={turn.content}
                            readOnly={isReadonly}
                            onChange={(e) => {
                              const next = [...editPrimer]
                              next[index] = { ...turn, content: e.target.value }
                              updatePrimer(next)
                            }}
                            className={cn('min-h-16 resize-y text-xs', isReadonly && 'opacity-60 cursor-not-allowed')}
                            placeholder={turn.role === 'user' ? '示范用户输入' : '示范助手应答'}
                          />
                          {!isReadonly && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => updatePrimer(editPrimer.filter((_, i) => i !== index))}
                              title="删除该轮"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 操作行 */}
                <div className="flex items-center gap-2 pt-1">
                  {selectedPersona.id !== defaultPersonaId && (
                    <Button variant="outline" size="sm" onClick={() => void handleSetDefault(selectedPersona.id)}>
                      <Star className="size-3.5 mr-1" />
                      设为默认
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={busy}>
                    <Download className="size-3.5 mr-1" />
                    导出 Markdown
                  </Button>
                  {!selectedPersona.builtin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive ml-auto"
                      onClick={() => void handleDelete(selectedPersona.id)}
                    >
                      <Trash2 className="size-3.5 mr-1" />
                      删除
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">
                从左侧选择一个人设
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

/** 人设列表项 */
interface PersonaListItemProps {
  persona: Persona
  isSelected: boolean
  isDefault: boolean
  isHovered: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onHoverChange: (id: string | null) => void
}

function PersonaListItem({
  persona,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange,
}: PersonaListItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50' : 'hover:bg-muted/50'
      )}
      onClick={() => onSelect(persona.id)}
      onMouseEnter={() => onHoverChange(persona.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{persona.name}</span>
          {persona.builtin && (
            <span className="text-xs text-muted-foreground shrink-0">(内置)</span>
          )}
          {isDefault && (
            <Star className="size-3.5 text-amber-500 fill-amber-500 shrink-0" />
          )}
        </div>
        {persona.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">{persona.description}</div>
        )}
      </div>

      <div className={cn(
        'flex items-center gap-1 shrink-0 transition-opacity',
        isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
      )}>
        {!isDefault && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation()
              onSetDefault(persona.id)
            }}
            title="设为默认"
          >
            <Star className="size-3.5 text-muted-foreground" />
          </Button>
        )}
        {!persona.builtin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(persona.id)
            }}
            title="删除"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}