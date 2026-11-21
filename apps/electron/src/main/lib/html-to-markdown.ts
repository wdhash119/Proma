/**
 * 极简 HTML → Markdown 转换。
 *
 * WebFetch 只需要「人能读、模型能读」的正文，不需要像素级保真，
 * 因此这里不做完整 HTML 解析，只处理有语义价值的标签，其余一律剥掉：
 * - 丢弃 script/style/noscript/svg/iframe/template 及其内容；
 * - 优先取 `<article>` / `<main>` / `<body>` 作为正文范围；
 * - 标题、段落、列表、引用、代码块、链接、强调转换为对应 Markdown；
 * - 其余标签剥离但保留内部文本，折叠多余空行。
 *
 * 纯函数、无依赖，可直接在 main 进程与测试中运行。
 */

/** 内容完全丢弃的标签。 */
const DROP_WITH_CONTENT = [
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'canvas', 'object', 'embed',
  'form', 'nav', 'footer', 'aside',
]

/** 行内标签 → Markdown 包裹（保留内部内容）。 */
const INLINE_MARKERS: Record<string, [string, string]> = {
  strong: ['**', '**'],
  b: ['**', '**'],
  em: ['*', '*'],
  i: ['*', '*'],
  del: ['~~', '~~'],
  s: ['~~', '~~'],
  code: ['`', '`'],
  kbd: ['`', '`'],
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
    hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·',
  }
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[body.toLowerCase()] ?? match
  })
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, '')
}

/** 移除指定标签连同其内容（大小写不敏感，支持嵌套的简单场景）。 */
function removeElements(html: string, tags: string[]): string {
  let result = html
  for (const tag of tags) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
    // 反复剥离以处理同名嵌套标签。
    let previous: string
    do {
      previous = result
      result = result.replace(pattern, '')
    } while (result !== previous)
    // 自闭合或未闭合。
    result = result.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }
  return result
}

function readAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  if (!match) return null
  const raw = match[2] ?? match[3] ?? match[4] ?? ''
  return raw.trim() || null
}

/** 取正文范围：优先 article/main，其次 body，最后整段。 */
export function extractMainHtml(html: string): string {
  for (const tag of ['article', 'main']) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(html)
    if (match?.[1] && stripTags(match[1]).trim().length > 200) return match[1]
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)
  return body?.[1] ?? html
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  if (!match?.[1]) return null
  const title = decodeEntities(stripTags(match[1])).trim()
  return title || null
}

/**
 * 把 HTML 转成可读 Markdown。
 * `options.maxChars` 用于截断超长正文，截断处会显式标注。
 */
export function htmlToMarkdown(html: string, options: { maxChars?: number } = {}): string {
  if (!html) return ''

  let source = extractMainHtml(html)
  source = removeElements(source, DROP_WITH_CONTENT)
  source = removeElements(source, ['head'])
  // 注释不产生内容。
  source = source.replace(/<!--[\s\S]*?-->/g, '')

  // 代码块先抽出来占位，避免内部标签被后续规则改写。
  const codeBlocks: string[] = []
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner: string) => {
    const codeAttr = /<code\b([^>]*)>/i.exec(inner)
    const language = codeAttr ? readAttribute(codeAttr[1] ?? '', 'class')?.replace(/^.*language-/, '') ?? '' : ''
    const text = decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, '')
    const index = codeBlocks.push(`\`\`\`${language}\n${text}\n\`\`\``) - 1
    return `\n\n\u0000CODE${index}\u0000\n\n`
  })

  // 换行先处理：块级转换会锁住内部文本，之后 <br> 会被当作普通标签剥掉。
  source = source.replace(/<br\b[^>]*\/?>/gi, '\n')

  // 块级结构。
  source = source.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
    const text = inlineToMarkdown(inner).trim()
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n'
  })

  source = source.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, inner: string) => {
    const text = inlineToMarkdown(inner).trim()
    if (!text) return '\n\n'
    return `\n\n${text.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}\n\n`
  })

  source = source.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_m, inner: string) => {
    const text = inlineToMarkdown(inner).trim().replace(/\n+/g, ' ')
    return text ? `\n- ${text}` : ''
  })
  source = source.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
  source = source.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n')
  source = source.replace(/<br\b[^>]*\/?>/gi, '\n')
  source = source.replace(/<\/?(?:p|div|section|table|thead|tbody|tr|header|figure|figcaption)\b[^>]*>/gi, '\n\n')
  source = source.replace(/<\/?t[dh]\b[^>]*>/gi, ' | ')

  source = inlineToMarkdown(source)

  // 还原代码块。
  source = source.replace(/\u0000CODE(\d+)\u0000/g, (_m, index: string) => codeBlocks[Number(index)] ?? '')

  // 折叠空行与行尾空白。
  source = source
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const maxChars = options.maxChars
  if (maxChars && source.length > maxChars) {
    return `${source.slice(0, maxChars)}\n\n…（内容过长，已截断）`
  }
  return source
}

/** 处理行内标签（链接、强调、代码、图片）。 */
function inlineToMarkdown(input: string): string {
  let result = input

  // 图片先于链接处理，避免 alt 被当成链接文本。
  result = result.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const alt = decodeEntities(readAttribute(attrs, 'alt') ?? '')
    const src = readAttribute(attrs, 'src')
    if (!src) return alt
    return `![${alt}](${src})`
  })

  result = result.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const href = readAttribute(attrs, 'href')
    const text = decodeEntities(stripTags(inner)).trim()
    if (!href || href.startsWith('javascript:')) return text
    if (!text) return href
    return `[${text}](${href})`
  })

  for (const [tag, [open, close]] of Object.entries(INLINE_MARKERS)) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'), (_m, inner: string) => {
      const text = decodeEntities(stripTags(inner)).trim()
      return text ? `${open}${text}${close}` : ''
    })
  }

  // 剩余标签：块级使用过的已替换，其他一律剥离。
  result = stripTags(result)
  // 内联空白归一，但保留换行（块级结构依赖它）。
  result = result.replace(/[ \t]{2,}/g, ' ')
  return decodeEntities(result)
}
