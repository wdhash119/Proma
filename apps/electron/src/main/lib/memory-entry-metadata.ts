/**
 * 单条记忆事实与可溯源后缀的解析、校验和单条操作。
 *
 * 后缀格式：`〔记忆：来源=…｜发生=…｜记录=…〕`，始终位于条目行尾。
 * 元数据不参与事实正文的去重判断；记录时间只由服务在真实写入时刷新。
 */

export class MemoryError extends Error {}

export const MAX_MEMORY_ENTRY_CHARS = 1000

export interface MemoryEntryOperation {
  op: 'add' | 'update' | 'remove'
  /** add / update 的新条目，必须是以 `- ` 开头的单行事实。 */
  entry?: string
  /** update / remove 的匹配文本；按行匹配，必须唯一命中。 */
  match?: string
  /** add 时插入到指定条目之后。 */
  after?: string
  /** 可选来源说明，不代表服务已经核验来源内容。 */
  source?: string
  /** 可选发生时间：YYYY-MM-DD 或带时区的 ISO 日期时间。 */
  occurredAt?: string
}

interface EntryMetadata {
  source?: string
  occurredAt?: string
  recordedAt?: string
}

interface ParsedEntry {
  /** 带 `- ` 前缀、去掉元数据后缀后的事实正文。 */
  body: string
  metadata: EntryMetadata
  hasMetadata: boolean
}

const META_PREFIX = '〔记忆：'
const META_SUFFIX = '〕'
const META_SEPARATOR = '｜'
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ZONED_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const META_FIELDS = ['source', 'occurredAt', 'recordedAt'] as const
const FIELD_LABELS: Record<(typeof META_FIELDS)[number], string> = {
  source: '来源',
  occurredAt: '发生',
  recordedAt: '记录',
}

function normalizeEntry(entry: string | undefined): string {
  const value = entry?.trim()
  if (!value) throw new MemoryError('entry 不能为空')
  if (!value.startsWith('- ')) throw new MemoryError('entry 必须是以 "- " 开头的单条事实')
  if (value.includes('\n') || value.includes('\r')) throw new MemoryError('entry 必须是单行事实')
  assertEntryLength(value, 'entry')
  return value
}

function assertEntryLength(entry: string, label: string): void {
  if (entry.length <= MAX_MEMORY_ENTRY_CHARS) return
  throw new MemoryError(
    `${label} 超过 ${MAX_MEMORY_ENTRY_CHARS} UTF-16 码元上限（当前 ${entry.length}）：请拆成多条事实，或按主题拆分正文`,
  )
}

function normalizeSource(source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  if (typeof source !== 'string') throw new MemoryError('source 必须是字符串')
  const value = source.trim()
  if (!value) throw new MemoryError('source 不能为空字符串；不需要溯源时请省略该字段')
  if (value.includes('\n') || value.includes('\r')) throw new MemoryError('source 必须是单行文本')
  if (/[〔〕｜]/.test(value)) {
    throw new MemoryError('source 不能包含「〔」「〕」或「｜」，这些字符会破坏记忆后缀结构')
  }
  return value
}

function assertCalendarDate(value: string): void {
  const [year, month, day] = value.split('-').map(Number)
  // Date.UTC 会把 0–99 年映射到 1900–1999 年；setUTCFullYear 才能按 ISO 原年校验。
  const date = new Date(0)
  date.setUTCFullYear(year!, month! - 1, day)
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month! - 1
    || date.getUTCDate() !== day
  ) {
    throw new MemoryError(`occurredAt 不是合法日期（该日不存在）：${value}`)
  }
}

function normalizeOccurredAt(occurredAt: string | undefined): string | undefined {
  if (occurredAt === undefined) return undefined
  if (typeof occurredAt !== 'string') throw new MemoryError('occurredAt 必须是字符串')
  const value = occurredAt.trim()
  if (!value) throw new MemoryError('occurredAt 不能为空字符串；不确定发生时间时请省略该字段')
  if (DATE_ONLY_PATTERN.test(value)) {
    assertCalendarDate(value)
    return value
  }
  if (!ZONED_DATETIME_PATTERN.test(value)) {
    throw new MemoryError(`occurredAt 必须是 YYYY-MM-DD 或带时区的 ISO 8601：${value}`)
  }
  assertCalendarDate(value.slice(0, 10))
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) throw new MemoryError(`occurredAt 不是合法时间：${value}`)
  const normalized = new Date(timestamp).toISOString()
  if (!ZONED_DATETIME_PATTERN.test(normalized)) {
    throw new MemoryError(`occurredAt 转为 UTC 后超出支持的四位年份范围：${value}`)
  }
  return normalized
}

function normalizeRecordedAt(value: string): string {
  if (DATE_ONLY_PATTERN.test(value) || !ZONED_DATETIME_PATTERN.test(value)) {
    throw new MemoryError(`记忆后缀的「记录」必须是带时区的 ISO 8601 时间：${value}`)
  }
  return normalizeOccurredAt(value)!
}

function parseEntry(entry: string): ParsedEntry {
  const start = entry.lastIndexOf(META_PREFIX)
  if (start < 0) return { body: entry, metadata: {}, hasMetadata: false }
  const suffixEnd = entry.indexOf(META_SUFFIX, start + META_PREFIX.length)
  if (suffixEnd < 0) {
    throw new MemoryError(`条目包含不完整的记忆后缀〔记忆：…〕：${entry}`)
  }
  // 例如「〔记忆：宫殿〕是术语」只是普通正文；只有闭合在行尾时才按元数据解析。
  if (suffixEnd !== entry.length - 1) return { body: entry, metadata: {}, hasMetadata: false }
  const body = entry.slice(0, start).trimEnd()
  if (body.includes(META_PREFIX) && body.endsWith(META_SUFFIX)) {
    throw new MemoryError(`一条事实只能有一个记忆后缀：${entry}`)
  }
  if (body === '-' || !body.startsWith('- ')) {
    throw new MemoryError(`记忆后缀前必须保留以 "- " 开头的事实正文：${entry}`)
  }
  const rawMetadata = entry.slice(start + META_PREFIX.length, suffixEnd)
  const metadata: EntryMetadata = {}
  let previousFieldIndex = -1

  for (const segment of rawMetadata.split(META_SEPARATOR)) {
    const separator = segment.indexOf('=')
    if (separator <= 0) throw new MemoryError(`记忆后缀缺少「字段=值」：${entry}`)
    const label = segment.slice(0, separator)
    const value = segment.slice(separator + 1).trim()
    const field = META_FIELDS.find((candidate) => FIELD_LABELS[candidate] === label)
    if (!field) throw new MemoryError(`记忆后缀包含未知字段「${label}」：${entry}`)
    const fieldIndex = META_FIELDS.indexOf(field)
    if (fieldIndex <= previousFieldIndex) {
      throw new MemoryError(`记忆后缀字段必须按 来源 → 发生 → 记录 排列且不能重复：${entry}`)
    }
    if (!value) throw new MemoryError(`记忆后缀字段「${label}」不能为空：${entry}`)
    previousFieldIndex = fieldIndex

    if (field === 'source') metadata.source = normalizeSource(value)
    else if (field === 'occurredAt') metadata.occurredAt = normalizeOccurredAt(value)
    else metadata.recordedAt = normalizeRecordedAt(value)
  }

  return { body, metadata, hasMetadata: true }
}

function formatMetadata(metadata: EntryMetadata): string {
  const segments: string[] = []
  if (metadata.source) segments.push(`来源=${metadata.source}`)
  if (metadata.occurredAt) segments.push(`发生=${metadata.occurredAt}`)
  if (metadata.recordedAt) segments.push(`记录=${metadata.recordedAt}`)
  return segments.length > 0 ? ` ${META_PREFIX}${segments.join(META_SEPARATOR)}${META_SUFFIX}` : ''
}

/** 只比较事实正文：剥离后缀、列表前缀并归一空白。 */
function entryIdentity(entry: string): string {
  const parsed = parseEntry(entry.trim())
  const body = parsed.body.trim()
  const fact = body.startsWith('- ') ? body.slice(2) : body
  return fact.trim().replace(/\s+/g, ' ')
}

/**
 * 只读的条目身份解析：剥离记忆后缀与 `- ` 前缀、归一空白，结果与条目写入时的去重口径一致。
 *
 * 与 `entryIdentity` 共用同一份解析逻辑；`error` 只说明该行为何不能按条目参与比较，
 * 供审计跳过畸形行而不是让整个审计失败。
 */
export function readMemoryEntryIdentity(line: string): { identity: string } | { error: string } {
  const trimmed = line.trim()
  if (!trimmed.startsWith('- ')) return { error: '不是以 "- " 开头的事实条目' }
  try {
    const identity = entryIdentity(trimmed)
    return identity ? { identity } : { error: '条目正文为空' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function findSameEntryIndex(lines: string[], entry: string, skipIndex?: number): number {
  const identity = entryIdentity(entry)
  return lines.findIndex((line, index) => {
    const candidate = line.trim()
    return index !== skipIndex && candidate.startsWith('- ') && entryIdentity(candidate) === identity
  })
}

function findSingleMatchIndex(lines: string[], match: string, op: string): number {
  const needle = match.trim()
  if (!needle) throw new MemoryError(`${op} 需要 match`)
  const indexes = lines
    .map((line, index) => (line.trim() === needle ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length === 0) throw new MemoryError(`未找到匹配条目：${needle}`)
  if (indexes.length > 1) throw new MemoryError(`匹配到多条相同条目，请提供更完整的文本：${needle}`)
  return indexes[0]!
}

function normalizeExplicitMetadata(operation: MemoryEntryOperation): EntryMetadata {
  return {
    source: normalizeSource(operation.source),
    occurredAt: normalizeOccurredAt(operation.occurredAt),
  }
}

function assertNoMetadataConflict(entry: string, parsed: ParsedEntry, explicit: EntryMetadata): void {
  if (explicit.source && parsed.metadata.source && explicit.source !== parsed.metadata.source) {
    throw new MemoryError(`source 与 entry 自带后缀冲突：${entry}`)
  }
  if (explicit.occurredAt && parsed.metadata.occurredAt && explicit.occurredAt !== parsed.metadata.occurredAt) {
    throw new MemoryError(`occurredAt 与 entry 自带后缀冲突：${entry}`)
  }
}

/**
 * 按单条事实修改正文。未涉及的标题、段落、条目顺序与原文换行保持不变。
 * `now` 仅供测试固定记录时间。
 */
export function applyMemoryOperations(
  content: string,
  operations: MemoryEntryOperation[],
  now: number = Date.now(),
): string {
  if (operations.length === 0) throw new MemoryError('operations 不能为空')
  let lines = content.split('\n')
  let changed = false

  for (const operation of operations) {
    if (operation.op === 'remove') {
      const index = findSingleMatchIndex(lines, operation.match ?? '', 'remove')
      lines = [...lines.slice(0, index), ...lines.slice(index + 1)]
      changed = true
      continue
    }

    const raw = normalizeEntry(operation.entry)
    const parsed = parseEntry(raw)
    const explicit = normalizeExplicitMetadata(operation)
    assertNoMetadataConflict(raw, parsed, explicit)

    if (operation.op === 'add') {
      const duplicateIndex = findSameEntryIndex(lines, raw)
      if (duplicateIndex >= 0) {
        const existing = parseEntry((lines[duplicateIndex] ?? '').trim())
        const wantedSource = explicit.source ?? parsed.metadata.source
        const wantedOccurredAt = explicit.occurredAt ?? parsed.metadata.occurredAt
        const providesSource = explicit.source !== undefined || parsed.metadata.source !== undefined
        const providesOccurredAt = explicit.occurredAt !== undefined || parsed.metadata.occurredAt !== undefined
        const noNewMetadata = !providesSource && !providesOccurredAt
        // 只比较本次实际提供的字段：旧条目里未重复提供的来源/发生时间应视为保留，而不是删除。
        const sameProvidedMetadata = (!providesSource || (existing.metadata.source ?? '') === (wantedSource ?? ''))
          && (!providesOccurredAt || (existing.metadata.occurredAt ?? '') === (wantedOccurredAt ?? ''))
        if (noNewMetadata || sameProvidedMetadata) continue
        throw new MemoryError('已存在同一正文的事实；来源或发生时间变化请用 update，不要追加重复事实')
      }

      const source = explicit.source ?? parsed.metadata.source
      const occurredAt = explicit.occurredAt ?? parsed.metadata.occurredAt
      const recordedAt = source || occurredAt ? new Date(now).toISOString() : undefined
      const entry = normalizeEntry(`${parsed.body}${formatMetadata({ source, occurredAt, recordedAt })}`)
      if (operation.after) {
        const anchor = findSingleMatchIndex(lines, operation.after, 'add')
        lines = [...lines.slice(0, anchor + 1), entry, ...lines.slice(anchor + 1)]
      } else {
        let insertAt = lines.length
        while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt -= 1
        lines = [...lines.slice(0, insertAt), entry, ...lines.slice(insertAt)]
      }
      changed = true
      continue
    }

    const index = findSingleMatchIndex(lines, operation.match ?? '', 'update')
    const current = parseEntry((lines[index] ?? '').trim())
    const source = explicit.source ?? parsed.metadata.source ?? current.metadata.source
    const occurredAt = explicit.occurredAt ?? parsed.metadata.occurredAt ?? current.metadata.occurredAt
    const bodyChanged = entryIdentity(parsed.body) !== entryIdentity(current.body)
    const metadataChanged = source !== current.metadata.source || occurredAt !== current.metadata.occurredAt
    if (!bodyChanged && !metadataChanged) continue
    if (bodyChanged && findSameEntryIndex(lines, parsed.body, index) >= 0) {
      throw new MemoryError(`update 会把条目改成已存在的另一条事实：${entryIdentity(parsed.body)}`)
    }

    const hasMetadata = Boolean(source || occurredAt || current.metadata.recordedAt)
    const recordedAt = hasMetadata ? new Date(now).toISOString() : undefined
    const entry = normalizeEntry(
      `${parsed.body}${hasMetadata ? formatMetadata({ source, occurredAt, recordedAt }) : ''}`,
    )
    if (lines[index] === entry) continue
    lines = [...lines.slice(0, index), entry, ...lines.slice(index + 1)]
    changed = true
  }

  if (!changed) return content
  const next = lines.join('\n')
  return next.endsWith('\n') || next.length === 0 ? next : `${next}\n`
}

/** 整篇写入与 operations 共用条目长度、后缀格式和正文去重约束。 */
export function assertMemoryContentEntries(content: string): void {
  if (/\r(?!\n)/.test(content)) {
    throw new MemoryError('content 包含独立的 CR 换行，请规范为 LF 或 CRLF 后再写入')
  }
  const firstSeen = new Map<string, number>()
  const duplicates: Array<{ firstLine: number; duplicateLine: number; entry: string }> = []

  for (const [index, line] of content.split('\n').entries()) {
    const entry = line.trim()
    if (!entry.startsWith('- ')) continue
    try {
      assertEntryLength(entry, `第 ${index + 1} 行的条目`)
      const identity = entryIdentity(entry)
      const previous = firstSeen.get(identity)
      if (previous === undefined) firstSeen.set(identity, index + 1)
      else duplicates.push({ firstLine: previous, duplicateLine: index + 1, entry })
    } catch (error) {
      if (error instanceof MemoryError && error.message.startsWith('第 ')) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new MemoryError(`第 ${index + 1} 行的记忆条目无效：${reason}`)
    }
  }

  if (duplicates.length === 0) return
  const detail = duplicates
    .map((item) => `第 ${item.duplicateLine} 行与第 ${item.firstLine} 行重复「${item.entry}」`)
    .join('；')
  throw new MemoryError(`记忆正文包含重复的 "- " 条目：${detail}。同一事实只保留一条。`)
}
