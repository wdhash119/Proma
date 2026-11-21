/**
 * HTML 实体解码（WebFetch / WebSearch 共用）。
 *
 * 只覆盖网页正文里常见的命名实体与数值实体：
 * - 数值实体在 `String.fromCodePoint` 前校验码点范围，非法值原样保留，
 *   避免 `&#x110000;` 之类的有限数抛 RangeError 导致整页/整次检索失败；
 * - 未知命名实体保留原文，不猜测语义。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
}

/** 合法的 Unicode 码点上限（含）。 */
const MAX_CODE_POINT = 0x10ffff

function fromCodePointOrOriginal(code: number, original: string): string {
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return original
  return String.fromCodePoint(code)
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return fromCodePointOrOriginal(Number.parseInt(body.slice(2), 16), match)
    }
    if (body.startsWith('#')) {
      return fromCodePointOrOriginal(Number.parseInt(body.slice(1), 10), match)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}
