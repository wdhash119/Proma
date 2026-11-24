/**
 * 记忆只读审计。
 *
 * 审计只回答问题「哪些地方可能重复或对不上」，不回答「哪条才对」：
 * 所有发现都是启发式候选，需要人读原文再决定删除、合并或改写。
 * 因此本模块不写入任何文件、不产生历史快照、不改变 revision，
 * 也不会自动合并、覆盖或挑选「较新」的条目。
 */

import { readdirSync } from 'node:fs'

import { readMemoryEntryIdentity } from './memory-entry-metadata'
import {
  GLOBAL_PROFILE_TARGET,
  PROJECT_INDEX_TARGET,
  getGlobalMemoryFilePath,
  getWorkspaceMemoryDirectory,
  readMemoryFileAt,
} from './memory-service'

export type MemoryAuditFindingKind =
  | 'exact-duplicate'
  | 'near-duplicate'
  | 'possible-conflict'
  | 'unindexed-theme'
  | 'dangling-route'

export interface MemoryAuditFinding {
  kind: MemoryAuditFindingKind
  /** 发现所在记忆目标；路由类发现指向提供路由的索引目标。 */
  target: string
  /** 1 基行号，按目标文件内的发现顺序升序。 */
  lines: number[]
  /** 条目正文（已剥离记忆后缀与列表前缀）；路由类发现为路由原文。 */
  texts: string[]
  /** 仅近似与冲突类发现提供：0–1 的正文相似度。 */
  similarity?: number
  /** 仅 dangling-route 提供：被引用但解析后不存在的目标。 */
  route?: string
}

export interface MemoryAuditReport {
  findings: MemoryAuditFinding[]
  /** 因为超过候选上限而被截断的发现类型；只列出确实丢掉了更多候选的类型。 */
  truncatedKinds: MemoryAuditFindingKind[]
  scannedTargets: number
  scannedEntries: number
}

/** 近似重复阈值：只差个别字才提示，避免把同主题不同事实算成重复。 */
const NEAR_DUPLICATE_THRESHOLD = 0.82
/** 冲突阈值放宽一些：否定词会显著改变字面相似度，但仍要求整体高度相似。 */
const POSSIBLE_CONFLICT_THRESHOLD = 0.35
/** 字符集合重合度的下限：否定词本身很短，靠它单独把无关事实拉近是误报的来源。 */
const POSSIBLE_CONFLICT_CHAR_COVERAGE = 0.7
/** 相邻窗口宽度：只见面近期邻居，避免 O(n²) 全量两两比较。 */
const NEIGHBOR_WINDOW = 4
/** 否定标记：只用于提示「可能冲突」，不用于判断谁对。 */
const NEGATION_MARKERS = ['不要', '不再', '禁止', '禁用', '拒绝', '避免', '不允许', '不能', '没有']
/** 单字「不」只排除高频非否定词；「别」容易命中分别/特别/区别，不作为冲突标记。 */
const SINGLE_BU_PATTERN = /不(?!同|但|断|变|足|少|多|错|确定)/g
const SINGLE_BU_EXCLUSIONS = /不要|不再|不允许|不能/g
const IDENTITY_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 50

const ROUTE_FENCE = '```'
const INDEX_ROUTE_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const CASE_INSENSITIVE_ROUTE_FS = process.platform === 'win32' || process.platform === 'darwin'
function routeKey(name: string): string {
  return CASE_INSENSITIVE_ROUTE_FS ? name.toLowerCase() : name
}
/** 只有这些目标承载人的事实；索引文件只提供路由。 */
const NON_ENTRY_TARGETS = new Set([PROJECT_INDEX_TARGET])

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  const value = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT
  return Math.min(Math.max(value, MIN_LIMIT), MAX_LIMIT)
}

interface EntryRecord {
  target: string
  line: number
  identity: string
}

/** 收集单个目标里可作为事实参与比较的行；畸形行与代码块内行跳过。 */
function collectEntries(target: string, content: string): EntryRecord[] {
  if (NON_ENTRY_TARGETS.has(target)) return []
  const entries: EntryRecord[] = []
  const lines = content.split('\n')
  let inFence = false
  let fenceStart = -1
  const collectLine = (index: number): void => {
    const line = (lines[index] ?? '').trimEnd()
    if (!line.trimStart().startsWith('- ')) return
    const parsed = readMemoryEntryIdentity(line)
    if ('error' in parsed) return
    entries.push({ target, line: index + 1, identity: parsed.identity })
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trimStart().startsWith(ROUTE_FENCE)) {
      if (inFence) {
        inFence = false
        fenceStart = -1
      } else {
        inFence = true
        fenceStart = index
      }
      continue
    }
    if (!inFence) collectLine(index)
  }
  // 未闭合围栏不能让后续事实无声消失：将剩余内容按普通 Markdown 再扫描一次。
  if (inFence && fenceStart >= 0) {
    for (let index = fenceStart + 1; index < lines.length; index++) collectLine(index)
  }
  return entries
}

/** 归一化相似度比较用的字符序列：去空白与标点，保留中英文与数字。 */
function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 相邻窗口内的相似度判断。
 *
 * 字符集合差异过大时直接跳过 Levenshtein 计算，既控制大文件的成本，
 * 也避免把明显不同的事实算成近似。
 */
function similarityOf(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (longer.length >= shorter.length * 2) return 0
  return 1 - levenshteinDistance(shorter, longer) / longer.length
}

/** 字符集合重合度：两边出现过多少相同字符，忽略顺序与重复次数。 */
function charCoverage(left: string, right: string): number {
  if (!left || !right) return 0
  const counts = new Map<string, number>()
  for (const char of left) counts.set(char, (counts.get(char) ?? 0) + 1)
  let shared = 0
  for (const char of right) {
    const remaining = counts.get(char) ?? 0
    if (remaining <= 0) continue
    shared += 1
    counts.set(char, remaining - 1)
  }
  return (2 * shared) / (left.length + right.length)
}

function levenshteinDistance(left: string, right: string): number {
  const previous: number[] = new Array(right.length + 1)
  const current: number[] = new Array(right.length + 1)
  for (let column = 0; column <= right.length; column++) previous[column] = column
  for (let row = 1; row <= left.length; row++) {
    const leftChar = left[row - 1]
    current[0] = row
    for (let column = 1; column <= right.length; column++) {
      const cost = leftChar === right[column - 1] ? 0 : 1
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      )
    }
    for (let column = 0; column <= right.length; column++) previous[column] = current[column] ?? 0
  }
  return previous[right.length] ?? 0
}

function negationCount(text: string): number {
  let count = 0
  let remaining = text
  for (const marker of NEGATION_MARKERS) {
    count += remaining.split(marker).length - 1
    remaining = remaining.replaceAll(marker, '')
  }
  count += remaining.match(/没/g)?.length ?? 0
  return count + (remaining.replace(SINGLE_BU_EXCLUSIONS, '').match(SINGLE_BU_PATTERN)?.length ?? 0)
}

function roundSimilarity(value: number): number {
  return Math.round(value * 100) / 100
}

interface PairCandidate {
  kind: MemoryAuditFindingKind
  target: string
  lines: number[]
  texts: string[]
  similarity: number
}

/** 相似度比较按排序后的正文进行，输出仍按原文件行号排列，保持 texts 与 lines 对齐。 */
function orderPairByLine(left: EntryRecord, right: EntryRecord): [EntryRecord, EntryRecord] {
  return left.line <= right.line ? [left, right] : [right, left]
}

/** 单目标内的完全重复、近似重复与疑似冲突；只在相邻窗口内两两比较。 */
function findEntryPairs(target: string, entries: EntryRecord[]): PairCandidate[] {
  const candidates: PairCandidate[] = []
  const entriesByIdentity = new Map<string, EntryRecord[]>()
  for (const entry of entries) {
    const group = entriesByIdentity.get(entry.identity) ?? []
    group.push(entry)
    entriesByIdentity.set(entry.identity, group)
  }
  for (const group of entriesByIdentity.values()) {
    if (group.length < 2) continue
    candidates.push({
      kind: 'exact-duplicate',
      target,
      lines: group.map((entry) => entry.line),
      texts: group.map((entry) => entry.identity),
      similarity: 1,
    })
  }

  // 先按正文排序，使相似事实成为邻居；比较窗口与原始书写顺序无关。
  const sortedEntries = [...entriesByIdentity.values()]
    .map((group) => group[0]!)
    .sort((left, right) => (
      IDENTITY_COLLATOR.compare(left.identity, right.identity) || left.line - right.line
    ))
  for (let index = 0; index < sortedEntries.length; index++) {
    const left = sortedEntries[index]!
    const leftNormalized = normalizeForSimilarity(left.identity)
    for (let next = index + 1; next <= index + NEIGHBOR_WINDOW && next < sortedEntries.length; next++) {
      const right = sortedEntries[next]!
      if (left.identity === right.identity) continue
      const rightNormalized = normalizeForSimilarity(right.identity)
      const similarity = similarityOf(leftNormalized, rightNormalized)
      const negationsDiffer = negationCount(left.identity) !== negationCount(right.identity)
      // 否定标记不对称意味着两条事实可能相互否定：宁可报冲突候选，也不报「近似重复」。
      if (similarity >= NEAR_DUPLICATE_THRESHOLD && !negationsDiffer) {
        const [first, second] = orderPairByLine(left, right)
        candidates.push({
          kind: 'near-duplicate',
          target,
          lines: [first.line, second.line],
          texts: [first.identity, second.identity],
          similarity: roundSimilarity(similarity),
        })
        continue
      }
      if (
        negationsDiffer
        && similarity >= POSSIBLE_CONFLICT_THRESHOLD
        && charCoverage(leftNormalized, rightNormalized) >= POSSIBLE_CONFLICT_CHAR_COVERAGE
      ) {
        const [first, second] = orderPairByLine(left, right)
        candidates.push({
          kind: 'possible-conflict',
          target,
          lines: [first.line, second.line],
          texts: [first.identity, second.identity],
          similarity: roundSimilarity(similarity),
        })
      }
    }
  }

  return candidates
}

interface RouteRecord {
  line: number
  /** 路由原文（链接目标），用于在 dangling-route 里展示。 */
  raw: string
  /** 归一化后的目标文件名；为 undefined 表示不是本目录内的 Markdown 主题。 */
  themeName?: string
}

/**
 * 解析单条索引路由。
 *
 * 只接受本地、同目录、`.md` 的目标：外部 `.context` 绝对路径、Windows 盘符路径、
 * 跨目录相对路径、网站 URL 与非 Markdown 文件都不是本项目记忆主题，直接返回 undefined。
 */
function parseIndexRoute(rawLink: string): string | undefined {
  let link = rawLink.trim()
  if (!link) return undefined
  // Obsidian 允许 `<路径>` 包裹含空格的链接。
  if (link.startsWith('<') && link.endsWith('>')) link = link.slice(1, -1).trim()
  if (!link) return undefined
  // 去掉锚点或块引用后再判断目标。
  const hashIndex = link.indexOf('#')
  if (hashIndex >= 0) link = link.slice(0, hashIndex)
  const queryIndex = link.indexOf('?')
  if (queryIndex >= 0) link = link.slice(0, queryIndex)
  link = link.trim()
  if (!link) return undefined
  // 网站、协议相对链接与任何带 scheme 的地址都不是本地文件。
  if (URL_SCHEME_PATTERN.test(link) || link.startsWith('//')) return undefined
  // 绝对路径（POSIX 或 Windows）与「向上越级」的相对路径都属于外部资料。
  if (link.startsWith('/') || link.startsWith('\\') || link.startsWith('~')) return undefined
  if (/^[a-zA-Z]:[\\/]/.test(link)) return undefined

  let decoded = link
  try {
    decoded = decodeURIComponent(link)
  } catch {
    // 非法百分号编码按原文处理，不因此中断审计。
  }
  decoded = decoded.replace(/\\/g, '/')
  while (decoded.startsWith('./')) decoded = decoded.slice(2)
  if (!decoded || decoded.startsWith('../') || decoded.includes('/')) return undefined
  if (!decoded.toLowerCase().endsWith('.md')) return undefined
  if (routeKey(decoded) === routeKey(PROJECT_INDEX_TARGET)) return undefined
  return decoded
}

/** 收集索引里所有路由；跳过代码块、行内代码与转义示例。 */
function collectRoutes(content: string): RouteRecord[] {
  const routes: RouteRecord[] = []
  const lines = content.split('\n')
  let inFence = false
  let fenceStart = -1
  const collectLine = (index: number): void => {
    const line = (lines[index] ?? '').replace(/(`+)[^`\r\n]*?\1/g, (code) => ' '.repeat(code.length))
    for (const match of line.matchAll(INDEX_ROUTE_PATTERN)) {
      const raw = match[1]
      const matchIndex = match.index ?? 0
      if (raw === undefined || isEscapedLink(line, matchIndex)) continue
      routes.push({ line: index + 1, raw, themeName: parseIndexRoute(raw) })
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trimStart().startsWith(ROUTE_FENCE)) {
      if (inFence) {
        inFence = false
        fenceStart = -1
      } else {
        inFence = true
        fenceStart = index
      }
      continue
    }
    if (!inFence) collectLine(index)
  }
  if (inFence && fenceStart >= 0) {
    for (let index = fenceStart + 1; index < lines.length; index++) collectLine(index)
  }
  return routes
}

function isEscapedLink(line: string, bracketIndex: number): boolean {
  let backslashes = 0
  for (let index = bracketIndex - 1; index >= 0 && line[index] === '\\'; index--) backslashes += 1
  return backslashes % 2 === 1
}

function emptyReport(): MemoryAuditReport {
  return { findings: [], truncatedKinds: [], scannedTargets: 0, scannedEntries: 0 }
}

/**
 * 只读审计一个工作区的记忆。
 *
 * - exact-duplicate / near-duplicate / possible-conflict 只在同一目标内、相邻窗口内比较；
 * - unindexed-theme 报存在但 `MEMORY.md` 没有路由的活跃主题；
 * - dangling-route 报 `MEMORY.md` 指向的不存在或被淘汰的目标；
 * - 每类发现按 `limit`（夹到 1–50）截断，并把被截断的类型写入 `truncatedKinds`。
 *
 * 所有结果都是启发式候选，不是语义结论，也不会自动修改任何记忆。
 */
export function auditMemory(workspaceSlug?: string, limit?: number): MemoryAuditReport {
  const maxPerKind = clampLimit(limit)
  const report = emptyReport()

  const plan: Array<{ target: string; content: string }> = []
  const globalSnapshot = readMemoryFileAt(getGlobalMemoryFilePath())
  if (globalSnapshot.content.trim()) plan.push({ target: GLOBAL_PROFILE_TARGET, content: globalSnapshot.content })

  let themeNames: string[] = []
  let indexContent = ''
  if (workspaceSlug) {
    const projectDir = getWorkspaceMemoryDirectory(workspaceSlug)
    const indexSnapshot = readMemoryFileAt(`${projectDir}/${PROJECT_INDEX_TARGET}`)
    indexContent = indexSnapshot.content
    themeNames = listThemeFiles(projectDir)
    for (const name of themeNames) {
      const snapshot = readMemoryFileAt(`${projectDir}/${name}`)
      if (snapshot.content.trim()) plan.push({ target: name, content: snapshot.content })
    }
  }

  const entriesByTarget = new Map<string, EntryRecord[]>()
  let scannedEntries = 0
  for (const document of plan) {
    const entries = collectEntries(document.target, document.content)
    entriesByTarget.set(document.target, entries)
    scannedEntries += entries.length
  }
  report.scannedTargets = plan.length
  report.scannedEntries = scannedEntries

  const pairsByKind = new Map<MemoryAuditFindingKind, PairCandidate[]>([
    ['exact-duplicate', []],
    ['near-duplicate', []],
    ['possible-conflict', []],
  ])
  // 只在同一目标内比较：跨主题的相同措辞可能是不同作用域的事实。
  for (const document of plan) {
    for (const pair of findEntryPairs(document.target, entriesByTarget.get(document.target) ?? [])) {
      pairsByKind.get(pair.kind)?.push(pair)
    }
  }

  const findings: MemoryAuditFinding[] = []
  const truncatedKinds: MemoryAuditFindingKind[] = []

  const pushPairFindings = (kind: MemoryAuditFindingKind): void => {
    const pairs = (pairsByKind.get(kind) ?? []).sort(comparePairs)
    const accepted = pairs.slice(0, maxPerKind)
    for (const pair of accepted) {
      findings.push({
        kind,
        target: pair.target,
        lines: pair.lines,
        texts: pair.texts,
        similarity: pair.similarity,
      })
    }
    if (pairs.length > accepted.length) truncatedKinds.push(kind)
  }

  pushPairFindings('exact-duplicate')
  pushPairFindings('near-duplicate')
  pushPairFindings('possible-conflict')

  if (workspaceSlug) {
    const routes = collectRoutes(indexContent)
    const themeNameKeys = new Set(themeNames.map(routeKey))
    const routedThemes = new Set<string>()
    const dangling: MemoryAuditFinding[] = []
    for (const route of routes) {
      if (!route.themeName) continue
      routedThemes.add(routeKey(route.themeName))
      if (themeNameKeys.has(routeKey(route.themeName))) continue
      dangling.push({ kind: 'dangling-route', target: PROJECT_INDEX_TARGET, lines: [route.line], texts: [route.raw], route: route.themeName })
    }

    // 只报「有事实正文」的主题：空文件不构成需要补路由的入口。
    const unindexed: MemoryAuditFinding[] = []
    for (const name of themeNames) {
      if (routedThemes.has(routeKey(name))) continue
      const entries = entriesByTarget.get(name) ?? []
      if (entries.length === 0) continue
      const firstLine = entries[0]!.line
      unindexed.push({ kind: 'unindexed-theme', target: name, lines: [firstLine], texts: [entries[0]!.identity] })
    }

    const acceptedUnindexed = unindexed.slice(0, maxPerKind)
    findings.push(...acceptedUnindexed)
    if (unindexed.length > acceptedUnindexed.length) truncatedKinds.push('unindexed-theme')

    const sortedDangling = dangling.sort(compareFindings)
    const acceptedDangling = sortedDangling.slice(0, maxPerKind)
    findings.push(...acceptedDangling)
    if (sortedDangling.length > acceptedDangling.length) truncatedKinds.push('dangling-route')
  }

  // 输出顺序稳定：类型顺序固定，同类内按目标、行号排序，便于跨次比较与人工复核。
  findings.sort(compareFindings)
  report.findings = findings
  report.truncatedKinds = truncatedKinds
  return report
}

function listThemeFiles(projectDir: string): string[] {
  // 与 memory-service 的主题枚举保持同一口径：只取 memory/ 下直接的 Markdown 文件。
  try {
    return readdirSync(projectDir)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => name !== PROJECT_INDEX_TARGET && name !== 'user-profile.md' && name !== 'user_profile.md' && name !== 'project-preferences.md')
      .sort()
  } catch {
    return []
  }
}

const KIND_ORDER: MemoryAuditFindingKind[] = [
  'exact-duplicate',
  'near-duplicate',
  'possible-conflict',
  'unindexed-theme',
  'dangling-route',
]

function compareLines(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

function comparePairs(left: PairCandidate, right: PairCandidate): number {
  if (left.target !== right.target) return left.target < right.target ? -1 : 1
  const lineDiff = compareLines(left.lines, right.lines)
  if (lineDiff !== 0) return lineDiff
  if (left.similarity !== right.similarity) return right.similarity - left.similarity
  return left.texts.join('\u0000') < right.texts.join('\u0000') ? -1 : 1
}

function compareFindings(left: MemoryAuditFinding, right: MemoryAuditFinding): number {
  const kindDiff = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
  if (kindDiff !== 0) return kindDiff
  if (left.target !== right.target) return left.target < right.target ? -1 : 1
  return compareLines(left.lines, right.lines)
}
