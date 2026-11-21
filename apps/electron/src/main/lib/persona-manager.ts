/**
 * 人设（Persona）管理服务
 *
 * 负责人设库的 CRUD、默认人设、Markdown 导入导出，以及从旧系统提示词配置的一次性迁移。
 * 存储在 ~/.proma/personas.json（原子写）；内置人设只读，每次读取时与源码种子合并。
 *
 * 人设供两条链路消费：
 * - Agent：编排层按会话 personaId（回退默认）解析人设，正文注入系统提示词、示范轮注入请求上下文。
 * - 侧栏问答：渲染层把人设正文作为 systemMessage、示范轮作为历史前缀随发送参数传入。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dialog } from 'electron'
import { getPersonasPath, getSystemPromptsPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import {
  BUILTIN_DEFAULT_PERSONA_ID,
  normalizePersonaConfig,
  normalizePrimerTurns,
  parsePersonaMarkdown,
  sanitizePersonaId,
  serializePersonaMarkdown,
  type Persona,
  type PersonaConfig,
  type PersonaCreateInput,
  type PersonaExportResult,
  type PersonaImportResult,
  type PersonaUpdateInput,
} from '@proma/shared'

/** 旧版系统提示词配置的最小读取形状（仅迁移用；旧模块已退役） */
interface LegacySystemPromptConfig {
  prompts?: Array<{
    id: string
    name?: string
    content?: string
    isBuiltin?: boolean
    createdAt?: number
    updatedAt?: number
  }>
  defaultPromptId?: string
}

/** 读取并归一化配置；首次读取时执行旧系统提示词迁移 */
function readConfig(): PersonaConfig {
  const filePath = getPersonasPath()
  let raw: Partial<PersonaConfig> | undefined
  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<PersonaConfig>
    } catch (error) {
      console.error('[人设] 读取配置失败，使用默认配置:', error)
    }
  }
  const config = normalizePersonaConfig(raw)
  if (!config.migratedFromSystemPrompts) {
    const migrated = migrateFromSystemPrompts(config)
    writeConfig(migrated)
    return migrated
  }
  return config
}

/** 原子写入配置 */
function writeConfig(config: PersonaConfig): void {
  try {
    writeJsonFileAtomic(getPersonasPath(), config)
  } catch (error) {
    console.error('[人设] 写入配置失败:', error)
    throw new Error('写入人设配置失败')
  }
}

/**
 * 一次性迁移旧系统提示词（~/.proma/system-prompts.json）。
 *
 * 自定义提示词保留为用户人设（内容不丢失）；默认提示词映射为默认人设。
 * 旧文件保留不动，迁移标记写入新配置，避免重复导入用户已删除的条目。
 */
function migrateFromSystemPrompts(config: PersonaConfig): PersonaConfig {
  const legacyPath = getSystemPromptsPath()
  if (!existsSync(legacyPath)) {
    return { ...config, migratedFromSystemPrompts: true }
  }

  let legacy: LegacySystemPromptConfig
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as LegacySystemPromptConfig
  } catch (error) {
    console.warn('[人设] 旧系统提示词配置读取失败，跳过迁移:', error)
    return { ...config, migratedFromSystemPrompts: true }
  }

  const existingIds = new Set(config.personas.map((persona) => persona.id))
  const migratedPersonas: Persona[] = []
  const idMapping = new Map<string, string>()
  for (const prompt of legacy.prompts ?? []) {
    if (prompt.isBuiltin) {
      idMapping.set(prompt.id, BUILTIN_DEFAULT_PERSONA_ID)
      continue
    }
    const id = sanitizePersonaId(`migrated-${prompt.id || randomUUID()}`)
    if (existingIds.has(id)) continue
    existingIds.add(id)
    idMapping.set(prompt.id, id)
    migratedPersonas.push({
      id,
      name: prompt.name?.trim() || '迁移的提示词',
      description: '从旧版系统提示词迁移',
      body: prompt.content ?? '',
      createdAt: prompt.createdAt || Date.now(),
      updatedAt: prompt.updatedAt || Date.now(),
    })
  }

  const mappedDefault = legacy.defaultPromptId ? idMapping.get(legacy.defaultPromptId) : undefined
  const next: PersonaConfig = {
    ...config,
    personas: [...config.personas, ...migratedPersonas],
    defaultPersonaId: mappedDefault ?? config.defaultPersonaId,
    migratedFromSystemPrompts: true,
  }
  if (migratedPersonas.length > 0) {
    console.log(`[人设] 已从旧系统提示词迁移 ${migratedPersonas.length} 个人设`)
  }
  return normalizePersonaConfig(next)
}

/** 生成不冲突的自定义人设 ID（custom-1、custom-2…） */
function nextCustomPersonaId(personas: Persona[]): string {
  const used = new Set(personas.map((persona) => persona.id))
  let index = 1
  while (used.has(`custom-${index}`)) index += 1
  return `custom-${index}`
}

/** 获取人设配置（含内置人设） */
export function getPersonaConfig(): PersonaConfig {
  return readConfig()
}

/** 创建自定义人设 */
export function createPersona(input: PersonaCreateInput): Persona {
  const config = readConfig()
  const now = Date.now()
  const persona: Persona = {
    id: nextCustomPersonaId(config.personas),
    name: input.name.trim() || '新人设',
    description: input.description?.trim() ?? '',
    body: input.body ?? '',
    primerTurns: normalizePrimerTurns(input.primerTurns),
    createdAt: now,
    updatedAt: now,
  }
  config.personas.push(persona)
  writeConfig(config)
  console.log(`[人设] 已创建: ${persona.name} (${persona.id})`)
  return persona
}

/** 更新自定义人设（内置只读） */
export function updatePersona(id: string, input: PersonaUpdateInput): Persona {
  const config = readConfig()
  const persona = config.personas.find((item) => item.id === id)
  if (!persona) throw new Error(`人设不存在: ${id}`)
  if (persona.builtin) throw new Error('内置人设不可编辑')

  if (input.name !== undefined) persona.name = input.name.trim() || persona.name
  if (input.description !== undefined) persona.description = input.description.trim()
  if (input.body !== undefined) persona.body = input.body
  if (input.primerTurns !== undefined) persona.primerTurns = normalizePrimerTurns(input.primerTurns)
  persona.updatedAt = Date.now()

  writeConfig(config)
  return persona
}

/** 删除自定义人设（内置不可删除；删除默认人设时回退默认助手） */
export function deletePersona(id: string): void {
  const config = readConfig()
  const persona = config.personas.find((item) => item.id === id)
  if (!persona) throw new Error(`人设不存在: ${id}`)
  if (persona.builtin) throw new Error('内置人设不可删除')

  config.personas = config.personas.filter((item) => item.id !== id)
  if (config.defaultPersonaId === id) {
    config.defaultPersonaId = BUILTIN_DEFAULT_PERSONA_ID
  }
  writeConfig(config)
  console.log(`[人设] 已删除: ${persona.name} (${id})`)
}

/** 设置默认人设；null 回退默认助手 */
export function setDefaultPersona(id: string | null): void {
  const config = readConfig()
  if (id !== null && !config.personas.some((persona) => persona.id === id)) {
    throw new Error(`人设不存在: ${id}`)
  }
  config.defaultPersonaId = id ?? BUILTIN_DEFAULT_PERSONA_ID
  writeConfig(config)
  console.log(`[人设] 默认人设已设置: ${config.defaultPersonaId}`)
}

/**
 * 从 Markdown 文件导入人设（弹文件选择框）。
 *
 * 按 id 覆盖合并：命中用户人设则更新，命中内置 id 则拒绝，否则新建。
 * 文件格式与 pi-app 人设 Markdown 兼容（frontmatter + 正文 + primer 注释块）。
 */
export async function importPersonaMarkdown(): Promise<PersonaImportResult> {
  const result = await dialog.showOpenDialog({
    title: '导入人设 Markdown',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  })
  const filePath = result.filePaths[0]
  if (result.canceled || !filePath) {
    return { success: false, message: '已取消导入' }
  }

  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error('[人设] 导入文件读取失败:', error)
    return { success: false, message: '文件读取失败' }
  }

  const fallbackId = basename(filePath).replace(/\.(md|markdown|txt)$/i, '')
  const parsed = parsePersonaMarkdown(text, fallbackId)
  if (!parsed) {
    return { success: false, message: '未解析到有效人设内容（需要正文或名称）' }
  }

  const config = readConfig()
  const existing = config.personas.find((persona) => persona.id === parsed.id)
  if (existing?.builtin) {
    return { success: false, message: `「${existing.name}」是内置人设，不可覆盖；请修改文件中的 id` }
  }

  if (existing) {
    existing.name = parsed.name
    existing.description = parsed.description
    existing.body = parsed.body
    existing.primerTurns = parsed.primerTurns
    if (parsed.order !== undefined) existing.order = parsed.order
    existing.updatedAt = Date.now()
    writeConfig(config)
    console.log(`[人设] 已导入并更新: ${existing.name} (${existing.id})`)
    return { success: true, persona: existing }
  }

  const persona: Persona = { ...parsed, createdAt: Date.now(), updatedAt: Date.now() }
  config.personas.push(persona)
  writeConfig(config)
  console.log(`[人设] 已导入: ${persona.name} (${persona.id})`)
  return { success: true, persona }
}

/** 导出人设为 Markdown 文件（弹保存框） */
export async function exportPersonaMarkdown(id: string): Promise<PersonaExportResult> {
  const config = readConfig()
  const persona = config.personas.find((item) => item.id === id)
  if (!persona) return { success: false, message: `人设不存在: ${id}` }

  const result = await dialog.showSaveDialog({
    title: '导出人设 Markdown',
    defaultPath: join(persona.id.endsWith('.md') ? persona.id : `${persona.id}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (result.canceled || !result.filePath) {
    return { success: false, message: '已取消导出' }
  }

  try {
    writeFileSync(result.filePath, serializePersonaMarkdown(persona), 'utf-8')
  } catch (error) {
    console.error('[人设] 导出写入失败:', error)
    return { success: false, message: '文件写入失败' }
  }
  return { success: true }
}