/**
 * 人设（Persona）类型与工具
 *
 * 人设是会话级的角色/风格覆盖层：一段 Markdown 正文（body）+ 可选的静态示范对话
 * （primerTurns）。Agent 把人设正文注入系统提示词、示范轮注入请求上下文；
 * 侧栏「问答」把人设正文作为 systemMessage。
 *
 * 设计参考 pi-app 的人设管理（master-detail 库 + 会话选择器 + Markdown 导入导出），
 * 但剥离其抗拦截机制（历史清洗、同音词替换、虚拟工具中继等），只保留干净的人设骨架。
 *
 * 存储在 ~/.proma/personas.json；内置人设只读，每次读取时与源码种子合并。
 */

/** 人设示范对话轮（注入在系统提示词之后、真实历史之前的静态 few-shot 前缀） */
export interface PersonaPrimerTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 问答注入模式。
 *
 * - append：内置基线 + 人设段（与 Agent 侧一致，人设定义角色与风格）；新建人设默认。
 * - replace：仅人设正文作为完整 systemMessage（替换基线，正文需自带完整角色与协作约束）；
 *   从旧系统提示词迁移来的人设默认，保留原作者的整体替换意图。
 */
export type PersonaQaInjection = 'append' | 'replace'

/** 问答注入模式的缺省值（新建人设与非法值回退都用它） */
export const DEFAULT_QA_INJECTION: PersonaQaInjection = 'append'

/** 人设 */
export interface Persona {
  /** 唯一标识（小写字母数字与 -_，≤64 字符） */
  id: string
  /** 名称 */
  name: string
  /** 简短说明（列表展示用） */
  description: string
  /** 人设正文（Markdown） */
  body: string
  /** 静态示范对话（可选，≤8 轮） */
  primerTurns?: PersonaPrimerTurn[]
  /** 问答注入模式（缺省按 append 处理；仅侧栏问答使用，不影响 Agent） */
  qaInjection?: PersonaQaInjection
  /** 是否内置（只读，不可编辑/删除） */
  builtin?: boolean
  /** 排序权重（小在前） */
  order?: number
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 人设配置 */
export interface PersonaConfig {
  /** 人设列表（含内置） */
  personas: Persona[]
  /** 默认人设 ID（新会话未显式选择时使用） */
  defaultPersonaId: string
  /** 已完成从旧系统提示词配置的一次性迁移 */
  migratedFromSystemPrompts?: boolean
}

/** 创建人设输入 */
export interface PersonaCreateInput {
  name: string
  description?: string
  body: string
  primerTurns?: PersonaPrimerTurn[]
  /** 问答注入模式（缺省 append） */
  qaInjection?: PersonaQaInjection
}

/** 更新人设输入（内置人设不可更新） */
export interface PersonaUpdateInput {
  name?: string
  description?: string
  body?: string
  primerTurns?: PersonaPrimerTurn[]
  /** 问答注入模式（仅接受 'append' / 'replace'） */
  qaInjection?: PersonaQaInjection
}

/** Markdown 导入结果 */
export interface PersonaImportResult {
  success: boolean
  persona?: Persona
  message?: string
}

/** Markdown 导出结果 */
export interface PersonaExportResult {
  success: boolean
  message?: string
}

/** 默认助手人设 ID：Agent 不注入该人设；侧栏问答使用 QA_BASELINE_SYSTEM_PROMPT 作为基线 */
export const BUILTIN_DEFAULT_PERSONA_ID = 'builtin-default'

/** 示范对话上限 */
export const MAX_PRIMER_TURNS = 8

/**
 * 规范化问答注入模式。
 *
 * 仅 'replace' 与 'append' 是合法值；缺失时按 backfillReplace 决定是否回补 'replace'
 * （存量迁移人设保留旧的整体替换语义），其余非法值一律回退 append。
 */
export function normalizeQaInjection(
  value: unknown,
  options: { backfillReplace?: boolean } = {},
): PersonaQaInjection {
  if (value === 'replace') return 'replace'
  if (value === 'append') return 'append'
  if (value === undefined || value === null) {
    return options.backfillReplace ? 'replace' : DEFAULT_QA_INJECTION
  }
  return DEFAULT_QA_INJECTION
}

/**
 * 侧栏问答的内置基线 systemMessage；不是人设内容，不出现在人设编辑器。
 * 沿用旧版内置系统提示词，保证问答迁移后行为不变。
 */
export const QA_BASELINE_SYSTEM_PROMPT = `你首先是某个大模型，这我们当然知道，你现在的任务是作为 Proma AI 助手，来帮助我解决实际问题。 

你需要在以下一些方面上保持关注：

**1.直接解决问题，但先确保信息完整**

- 优先调用记忆工具（如果有），了解我的偏好或背景信息
- 优先给出简洁的解决方案
- 如果方案依赖前置信息或关键决策，先向我提问
- 如果我的需求可能忽略了重要的知识点（如安全性、性能、最佳实践），主动提醒我，但保持简洁

**2.渐进式引导，降低认知压力**

- 多步骤复杂教程：先给出结构和选项，让我选择后再展开
- 多种方法：先对比各方案的适用场景和权衡，让我决定后再详细说明
- 复杂概念：先给核心要点，我需要时再深入

**3.根据上下文推测我的水平**

- 从我的提问方式、使用的术语判断我的能力水平
- 调整解释的深度：新手多解释概念，熟手直接给方案
- 不确定时可以直接问我："你对 [概念] 熟悉吗？"

**4.遇到不确定时主动询问，避免主观决断**

- 技术选型、架构决策、配置参数等关键选择，先问我的场景和需求
- 如果有多个合理方案，列出对比让我选择，而不是替我决定
- 避免使用过多默认值，除非是行业标准

**5.识别学习场景，提供适当支持**

- 当我在学习新概念时，避免引入超出当前范围认知的复杂内容
- 多鼓励，少批评
- 可以主动提示："这个涉及到 [高级概念]，我们可以先跳过，等基础掌握后再回来"

**6.保持耐心、人性化、简洁**

- 保持对我的关心和真实富有人性的理解
- 用自然的语言，不要过于正式或机械
- 直接回答问题，不要过度铺垫
- 承认不确定性，而不是强行给出模糊答案

**7.主动识别并提示知识内核**

- 当你发现有多种概念混杂或者逻辑混乱时，请主动点明并纠正
- 当我的问题可能触及某个重要概念但我可能并没能意识到时，主动提醒，帮我完成这种关联
- 格式："💡 你可能还需要考虑 [概念]，因为 [原因]"
- 如果忽略这些知识点可能导致问题，明确指出风险
- 但注意：只提示真正重要的，不要过度提醒造成信息过载

**8.关于工具**

- 我希望你能更主动积极地使用工具来获取信息和解决问题，而不是仅仅依赖于你内置的知识
- 当你觉得需要使用工具时，不要犹豫，直接使用
- 如果你不确定是否需要使用工具，可以先问我："我觉得这个问题可能需要使用 [工具] 来更好地解决，你觉得呢？"
- 尤其需要注意的是主动使用记忆工具来获取我的偏好和背景信息，这样可以更好地定制化你的回答`

const BUILTIN_ENGINEER_BODY = `你是一名严谨的工程协作者，以证据和可验证性为先。

- 先调研再动手：修改前阅读相关代码、配置与既有约定，不凭文件名或习惯猜测。
- 最小改动：只改与任务直接相关的部分；不顺手重构、不覆盖用户已有改动。
- 实证优先：声称完成前运行相关测试或类型检查；未验证的内容明确标注为推测。
- 尊重项目契约：项目 AGENTS.md / 规则文件中的命令、边界与红线优先于通用习惯。
- 如实报告：失败、阻塞与不确定性直接说明，不用强化词修饰结果。
- 解释保持专业密度：术语照常使用，给出推理与依据，不为通俗而稀释内容。`

const BUILTIN_WRITER_BODY = `你是一名虚构创作协作者，擅长小说、角色扮演、分镜与文案。

- 虚构舞台公理：作品内的人物、世界与规则自洽即可；不把虚构内容当作现实事实陈述。
- 名实相离：角色言行服务于其动机与处境，避免作者腔的说教与总结。
- 感官细节：用具体可见、可听、可触的细节推进场景，少用抽象形容词堆砌。
- 节奏意识：张弛交替，冲突场景短句推进，铺陈场景留白呼吸。
- 尊重设定：用户给定的人物小传、世界观与风格约束优先于你的默认偏好。
- 交付完整：按要求给出可直接使用的成稿，而非大纲式敷衍；需要选择时先给方案再展开。`

const BUILTIN_CONCISE_BODY = `你是一名简洁高效的助手，以最短路径交付结果。

- 直接给答案与结论，省略铺垫、复述与客套。
- 代码与命令优先于文字描述；能一行说清的不写三段。
- 仅在影响正确性或存在真实分歧时提问，一次问全。
- 不确定就一句话标明，不展开免责声明。
- 保持专业准确：简洁不等于省略关键约束、风险与验证步骤。`

/** 内置人设种子（只读；每次读取配置时按 id 合并，内容始终与源码同步） */
export const BUILTIN_PERSONAS: readonly Persona[] = [
  {
    id: BUILTIN_DEFAULT_PERSONA_ID,
    name: 'Proma 默认助手',
    description: '默认人设：不注入额外提示词。Agent 使用产品系统提示词，侧栏问答使用内置基线。',
    body: '',
    builtin: true,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-engineer',
    name: '严谨工程协作',
    description: '证据优先、最小改动、实证验证的工程风格。',
    body: BUILTIN_ENGINEER_BODY,
    builtin: true,
    order: 10,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-writer',
    name: '虚构创作',
    description: '小说、角色扮演与分镜：舞台公理、感官细节、节奏意识。',
    body: BUILTIN_WRITER_BODY,
    builtin: true,
    order: 20,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-concise',
    name: '简洁直答',
    description: '最短路径交付结果，省略铺垫与客套。',
    body: BUILTIN_CONCISE_BODY,
    builtin: true,
    order: 30,
    createdAt: 0,
    updatedAt: 0,
  },
]

/** 规范化人设 ID：小写 a-z0-9_-，≤64 字符；非法输入回退 fallback */
export function sanitizePersonaId(rawId: string, fallbackId = 'persona'): string {
  const normalized = rawId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!normalized || normalized === 'active' || normalized === '.active') {
    return sanitizePersonaId(fallbackId, 'persona')
  }
  return normalized
}

/** 规范化示范对话：去空轮、截断上限、修剪空白 */
export function normalizePrimerTurns(turns: PersonaPrimerTurn[] | undefined): PersonaPrimerTurn[] | undefined {
  if (!turns || turns.length === 0) return undefined
  const normalized = turns
    .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.content.trim())
    .slice(0, MAX_PRIMER_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.trim() }))
  return normalized.length > 0 ? normalized : undefined
}

/**
 * 归一化人设配置（normalize-on-read）。
 *
 * 内置种子永远存在且内容与源码同步（只读语义）；用户人设保留。
 * 排序按 order 再按创建时间；defaultPersonaId 失效时回退默认助手。
 */
export function normalizePersonaConfig(raw: Partial<PersonaConfig> | undefined): PersonaConfig {
  const migratedFromSystemPrompts = raw?.migratedFromSystemPrompts === true
  const userPersonas = (raw?.personas ?? []).filter((persona) =>
    persona && typeof persona.id === 'string' && !persona.builtin && !BUILTIN_PERSONAS.some((seed) => seed.id === persona.id))
  const personas: Persona[] = [
    // 内置种子没有注入模式字段：统一按缺省 append 补齐，保证读取后字段完整
    ...BUILTIN_PERSONAS.map((seed) => ({ ...seed, qaInjection: DEFAULT_QA_INJECTION })),
    ...userPersonas.map((persona) => ({
      ...persona,
      name: persona.name?.trim() || persona.id,
      description: persona.description ?? '',
      body: persona.body ?? '',
      primerTurns: normalizePrimerTurns(persona.primerTurns),
      // 存量迁移人设（migrated- 前缀 + 已写入迁移标记）当时整体替换了 systemMessage，
      // 读取时补 'replace'，不重跑迁移
      qaInjection: normalizeQaInjection(persona.qaInjection, {
        backfillReplace: migratedFromSystemPrompts && persona.id.startsWith('migrated-'),
      }),
      createdAt: persona.createdAt ?? 0,
      updatedAt: persona.updatedAt ?? 0,
    })),
  ]
  personas.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const requestedDefault = raw?.defaultPersonaId
  const defaultPersonaId = requestedDefault && personas.some((persona) => persona.id === requestedDefault)
    ? requestedDefault
    : BUILTIN_DEFAULT_PERSONA_ID
  return {
    personas,
    defaultPersonaId,
    ...(raw?.migratedFromSystemPrompts ? { migratedFromSystemPrompts: true } : {}),
  }
}

/** 解析会话实际使用的人设：显式选择优先，否则回退默认人设 */
export function resolveSessionPersona(config: PersonaConfig, personaId?: string): Persona | undefined {
  const effectiveId = personaId ?? config.defaultPersonaId
  return config.personas.find((persona) => persona.id === effectiveId)
}

/**
 * 构建 Agent 系统提示词的人设段。
 *
 * 默认助手不注入（Agent 产品提示词已覆盖其职责）；空正文不注入。
 * 人设只定义角色与风格，不得覆盖工具使用与安全契约。
 */
export function buildPersonaPromptSection(persona: Persona | undefined): string | undefined {
  if (!persona || persona.id === BUILTIN_DEFAULT_PERSONA_ID) return undefined
  const body = persona.body.trim()
  if (!body) return undefined
  return `## 人设：${persona.name}

以下人设定义本次会话的角色、语气与协作风格；与工具使用和安全契约冲突时，以后者为准。

${body}`
}

/**
 * 构建侧栏问答的 systemMessage。
 *
 * - 人设不存在 → undefined（调用方回到服务端默认）；
 * - 默认助手 → 问答内置基线；
 * - append（缺省）→ 基线 + 人设段，空正文回落基线；
 * - replace → 仅人设正文，空正文返回 undefined。
 */
export function buildQaSystemMessage(persona: Persona | undefined): string | undefined {
  if (!persona) return undefined
  if (persona.id === BUILTIN_DEFAULT_PERSONA_ID) return QA_BASELINE_SYSTEM_PROMPT
  const body = persona.body.trim()
  if (persona.qaInjection === 'replace') return body || undefined
  const section = buildPersonaPromptSection(persona)
  return section ? `${QA_BASELINE_SYSTEM_PROMPT}\n\n${section}` : QA_BASELINE_SYSTEM_PROMPT
}

// ===== Markdown 导入导出（与 pi-app 人设文件格式兼容） =====

const PRIMER_MARKER_REGEX = /<!--\s*primer:(user|assistant)\s*-->/g

/**
 * 解析人设 Markdown 文档。
 *
 * 格式：可选 `---` frontmatter（简单 key: value 行，识别 id/name/title/description/desc/order）
 * + 正文 + 可选 `<!-- primer:user -->` / `<!-- primer:assistant -->` 示范轮块。
 * 正文与示范轮都为空时返回 null。
 */
export function parsePersonaMarkdown(text: string, fallbackId: string): Persona | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let rest = trimmed
  const meta: Record<string, string> = {}
  if (rest.startsWith('---')) {
    const end = rest.indexOf('\n---', 3)
    if (end !== -1) {
      const frontmatter = rest.slice(3, end)
      rest = rest.slice(end + 4).trim()
      for (const line of frontmatter.split('\n')) {
        const index = line.indexOf(':')
        if (index <= 0) continue
        const key = line.slice(0, index).trim().toLowerCase()
        const value = line.slice(index + 1).trim()
        if (key && value) meta[key] = value
      }
    }
  }

  const segments = rest.split(PRIMER_MARKER_REGEX)
  const body = (segments[0] ?? '').trim()
  const primerTurns: PersonaPrimerTurn[] = []
  for (let i = 1; i + 1 < segments.length; i += 2) {
    const role = segments[i]
    const content = segments[i + 1]
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      primerTurns.push({ role, content: content.trim() })
    }
  }

  const name = meta.name || meta.title || ''
  if (!body && !name && primerTurns.length === 0) return null

  const now = Date.now()
  const orderValue = meta.order ? Number.parseInt(meta.order, 10) : undefined
  return {
    id: sanitizePersonaId(meta.id || fallbackId, fallbackId),
    name: name || fallbackId,
    description: meta.description || meta.desc || '',
    body,
    primerTurns: normalizePrimerTurns(primerTurns),
    ...(orderValue !== undefined && Number.isFinite(orderValue) ? { order: orderValue } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

/** 序列化人设为 Markdown 文档（parsePersonaMarkdown 的逆操作） */
export function serializePersonaMarkdown(persona: Persona): string {
  const lines = [
    '---',
    `id: ${persona.id}`,
    `name: ${persona.name}`,
  ]
  if (persona.description) lines.push(`description: ${persona.description}`)
  if (persona.order !== undefined) lines.push(`order: ${persona.order}`)
  lines.push('---', '', persona.body.trim())
  for (const turn of persona.primerTurns ?? []) {
    lines.push('', `<!-- primer:${turn.role} -->`, '', turn.content.trim())
  }
  return `${lines.join('\n')}\n`
}

/** 人设相关 IPC 通道常量 */
export const PERSONA_IPC_CHANNELS = {
  /** 获取完整配置 */
  GET_CONFIG: 'persona:get-config',
  /** 创建人设 */
  CREATE: 'persona:create',
  /** 更新人设 */
  UPDATE: 'persona:update',
  /** 删除人设 */
  DELETE: 'persona:delete',
  /** 设置默认人设 */
  SET_DEFAULT: 'persona:set-default',
  /** 从 Markdown 文件导入（主进程弹文件选择框） */
  IMPORT_MARKDOWN: 'persona:import-markdown',
  /** 导出人设为 Markdown 文件（主进程弹保存框） */
  EXPORT_MARKDOWN: 'persona:export-markdown',
  /** 获取 Proma 默认系统提示词（设置页只读预览，中性上下文） */
  GET_DEFAULT_SYSTEM_PROMPT: 'persona:get-default-system-prompt',
} as const