/**
 * 项目地图（项目根 `AGENTS.md`）的读取、复查记录与行动提示。
 *
 * 「项目地图」指项目根那一份常驻 `AGENTS.md`：它记录不看就会在本项目犯错的
 * 子项目结构、常用命令与红线。这里负责三件事：
 * 1. 读出内容、字符数、revision，并判断是否需要复查；
 * 2. 记录「实际完成复查」的时间（写 Proma 元数据，不碰文件 mtime）；
 * 3. 生成注入系统提示的「本轮项目地图行动」段落。
 *
 * 字符数一律排除 `proma:memory` 关联块，避免把脚手架算进预算。
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { stripMemoryAssociation } from './project-memory-scaffold'
import { writeJsonFileAtomic } from './safe-file'

/** 项目地图复查间隔：一周。 */
export const PROJECT_MAP_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** 常驻项目护栏的字符预算（非空白字符）。 */
export const PROJECT_MAP_MAX_CHARS = 4000
/** 低于该字符数视为描述不足，需在本轮补全。 */
export const PROJECT_MAP_MIN_CHARS = 200

export type ProjectMapStatus = '已存在' | '待完善' | '缺失' | '不可安全修改'

export interface ProjectMapSnapshot {
  /** 期望路径：总是项目根下的 AGENTS.md。 */
  path: string
  status: ProjectMapStatus
  content?: string
  /** 去掉记忆关联块后的非空白字符数。 */
  characterCount?: number
  modifiedAt?: number
  /** 内容哈希；用于复查记录的乐观校验。 */
  revision?: string
}

export interface ProjectMapReviewState extends ProjectMapSnapshot {
  /** 上一次实际完成复查的时间（仅当 revision 仍匹配时有效）。 */
  checkedAt?: number
  /** 距离最近一次「修改或实际复查」是否已超过复查间隔。 */
  reviewDue: boolean
}

export interface ProjectMapReviewRecord {
  checkedAt: number
  revision: string
  summary: string
}

function countChars(content: string): number {
  return Array.from(content.replace(/\s/g, '')).length
}

/**
 * 读取项目地图。
 *
 * 只认项目根下的 `AGENTS.md` / `AGENTS.MD`，不向上越界；符号链接、目录等
 * 非普通文件一律标记「不可安全修改」，交由用户处理，不尝试改写。
 */
export function inspectProjectMap(projectRoot: string): ProjectMapSnapshot {
  for (const name of ['AGENTS.md', 'AGENTS.MD'] as const) {
    const path = join(projectRoot, name)
    try {
      const stats = lstatSync(path)
      if (!stats.isFile()) return { path, status: '不可安全修改' }
      const content = readFileSync(path, 'utf8')
      const projectContent = stripMemoryAssociation(content)
      const characterCount = countChars(projectContent)
      return {
        path,
        content,
        characterCount,
        modifiedAt: stats.mtimeMs,
        status: characterCount < PROJECT_MAP_MIN_CHARS ? '待完善' : '已存在',
        revision: createHash('sha256').update(`${name}\0${stats.mtimeMs}\0${content}`).digest('hex'),
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        return { path, status: '不可安全修改' }
      }
    }
  }
  return { path: join(projectRoot, 'AGENTS.md'), status: '缺失' }
}

/** 复查记录的落盘路径；按项目根真实路径做 key，避免中文与大小写差异。 */
function reviewRecordPath(workspaceRoot: string, projectRoot: string): string {
  let identity = resolve(projectRoot)
  try {
    identity = realpathSync.native(projectRoot)
  } catch { /* 项目根可能已删除，仍用 resolve 结果作为 key */ }
  const key = createHash('sha256').update(identity).digest('hex')
  return join(workspaceRoot, 'project-map-reviews', `${key}.json`)
}

/** 读取项目地图与复查状态；记录仅在 revision 匹配当前内容时生效。 */
export function readProjectMapReviewState(
  workspaceRoot: string,
  projectRoot: string,
  now = Date.now(),
): ProjectMapReviewState {
  const map = inspectProjectMap(projectRoot)
  let checkedAt: number | undefined
  try {
    const record = JSON.parse(readFileSync(reviewRecordPath(workspaceRoot, projectRoot), 'utf8')) as unknown
    if (
      record && typeof record === 'object'
      && 'revision' in record && record.revision === map.revision
      && 'checkedAt' in record && typeof record.checkedAt === 'number'
      && Number.isFinite(record.checkedAt) && record.checkedAt > 0 && record.checkedAt <= now
    ) {
      checkedAt = record.checkedAt
    }
  } catch { /* 无记录或记录损坏时按未复查处理 */ }

  return {
    ...map,
    checkedAt,
    // 文件从未修改过（缺失/不可改）时不算逾期，避免对空项目反复提醒。
    reviewDue: map.modifiedAt !== undefined
      && now - Math.max(map.modifiedAt, checkedAt ?? 0) > PROJECT_MAP_REVIEW_INTERVAL_MS,
  }
}

/**
 * 记录一次实际完成的复查。
 *
 * 必须带当前 revision：文件在此之后被改动时记录立即失效，
 * 也禁止用 `touch` 或改写 `AGENTS.md` 日期来伪造复查时间。
 */
export function completeProjectMapReview(
  workspaceRoot: string,
  projectRoot: string,
  revision: string,
  summary: string,
  now = Date.now(),
): ProjectMapReviewRecord {
  if (!summary.trim()) {
    throw new Error('请说明实际核验的内容、依据以及更新或无需更新的结论。')
  }
  const map = inspectProjectMap(projectRoot)
  if (!map.revision || map.status === '不可安全修改') {
    throw new Error('项目地图缺失或不可安全修改，不能记录检查完成。')
  }
  if (map.revision !== revision) {
    throw new Error('AGENTS.md 已发生变化，请重新读取并核验后再记录检查完成。')
  }
  const record: ProjectMapReviewRecord = { checkedAt: now, revision, summary: summary.trim() }
  const path = reviewRecordPath(workspaceRoot, projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}

/**
 * 生成注入系统提示的「本轮项目地图行动」段落。
 *
 * 无需要处理的事项时返回 undefined：普通问答、打开页面不该触发事实周检。
 */
export function buildProjectMapActionPrompt(map: ProjectMapReviewState): string | undefined {
  const actions: string[] = []

  if (map.status === '不可安全修改') return undefined

  if (map.status === '缺失') {
    actions.push('当前项目 AGENTS.md 缺失。本轮若在此项目开展工作，请根据已核验事实，在任务结束前建立项目地图。')
  } else if (map.characterCount === 0) {
    actions.push('当前项目 AGENTS.md 已存在但内容为空（0 个非空白字符）。本轮若在此项目开展工作，请根据已核验事实，在任务结束前补全该文件。')
  } else if (map.characterCount !== undefined && map.characterCount < PROJECT_MAP_MIN_CHARS) {
    actions.push(`当前项目 AGENTS.md 仅有 ${map.characterCount} 个非空白字符，对项目要求、结构或使用方式的描述可能明显不足。本轮项目任务中必须核验并确定需要补充或更新的内容，在收尾前完成有事实依据的更新；保留已有有效规则。若现有内容已足够或证据不足以补充，应说明判断，不为凑字数扩写。`)
  } else if (map.characterCount !== undefined && map.characterCount > PROJECT_MAP_MAX_CHARS) {
    actions.push(`当前项目 AGENTS.md 已有 ${map.characterCount} 个非空白字符，超过常驻项目护栏预算（${PROJECT_MAP_MAX_CHARS} 非空白字符）。禁止继续直接追加细节。本轮若为可写项目任务，请在收尾前执行下沉式瘦身：AGENTS.md 只保留子项目结构、常用命令与跨任务必守的全局红线（压回 ≤${PROJECT_MAP_MAX_CHARS} 字符）；将特定模块 SOP、部署/对账细节、历史排障经过和某日核验快照拆入或合并进项目 memory/*.md 主题文件，并在 MEMORY.md 留一行场景索引，确保既有知识零丢失。`)
  }

  if (map.reviewDue) {
    const date = (time: number): string => new Date(time).toLocaleString('zh-CN', { hour12: false })
    actions.push(`当前项目 AGENTS.md 上次修改于 ${date(map.modifiedAt ?? 0)}，${map.checkedAt ? `上次实际检查于 ${date(map.checkedAt)}` : '尚无当前版本的检查记录'}；距最近修改或检查已超过一周。部分要求或项目描述可能已经发生变化，请结合本轮项目任务检查是否仍然适用，必要时局部更新，并在实际完成核验后记录检查时间。`)
  }

  if (actions.length === 0) return undefined

  return `## 本轮项目地图行动
目标路径：\`${map.path}\`（${map.status}）。
${actions.join('\n')}
先读取 Coach 的 project-map reference；使用 ProjectMapInspect 读取当前文件与版本，结合本轮事实核验。若修改文件，写后再次调用 ProjectMapInspect 回读验证，再用返回的 revision 调用 ProjectMapReviewComplete，说明核验依据及更新或无需更新的结论。仅看到提醒、尚未核验或证据不足时，不得记录检查完成。检查时间由工具保存到 Proma 元数据，禁止通过 touch 或改写 AGENTS.md 日期代替。
只读要求与用户明确禁止写入仍优先，此时不修改文件或记录检查时间；普通问答和打开页面不触发项目事实核验；运行时要求的一次性基础能力维护仍按专用工具自动完成，无需扫描项目或记录事实周检。无需单独的初始化授权，不为凑字数填充内容。`
}
