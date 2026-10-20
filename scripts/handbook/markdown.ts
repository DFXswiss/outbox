export type MarkdownProblem = { file: string; line: number; message: string }

export class HandbookMarkdownError extends Error {
  readonly file: string
  readonly line: number

  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`)
    this.name = 'HandbookMarkdownError'
    this.file = file
    this.line = line
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&colon;|&#0*58;|&#x0*3a;/gi, ':')
    .replace(/&tab;|&#0*9;|&#x0*9;/gi, '\t')
    .replace(/&newline;|&#0*10;|&#x0*a;/gi, '\n')
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([a-f\d]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
}

function safeHref(target: string, file: string, line: number): string {
  const decoded = decodeEntities(target)
  if (decoded !== decoded.trim() || /[\u0000-\u0020\\]/.test(decoded)) {
    throw new HandbookMarkdownError(file, line, `unsafe link target: ${target}`)
  }
  if (/^#[A-Za-z][\w:.-]*$/.test(decoded)) return decoded
  let parsed: URL
  try {
    parsed = new URL(decoded)
  } catch {
    throw new HandbookMarkdownError(file, line, `unsafe link target: ${target}`)
  }
  if (
    !decoded.toLowerCase().startsWith('https://') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === ''
  ) {
    throw new HandbookMarkdownError(file, line, `unsafe link target: ${target}`)
  }
  return decoded
}

function inline(source: string, file: string, line: number): string {
  const pieces: string[] = []
  const pattern = /\[([^\]]+)\]\(([^)]*)\)/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    pieces.push(escapeHtml(source.slice(cursor, index)))
    const label = match[1]!
    const target = safeHref(match[2]!, file, line)
    pieces.push(`<a href="${escapeHtml(target)}">${escapeHtml(label)}</a>`)
    cursor = index + match[0].length
  }
  pieces.push(escapeHtml(source.slice(cursor)))
  return pieces.map((piece) => piece
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  ).join('')
}

export function renderMarkdown(source: string, file = '<markdown>'): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let paragraph: string[] = []
  let paragraphStart = 0
  let list: string[] = []
  let listStart = 0
  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${paragraph.map((line, offset) => inline(line, file, paragraphStart + offset)).join('<br>')}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (list.length) {
      output.push(`<ul>${list.map((item, offset) => `<li>${inline(item, file, listStart + offset)}</li>`).join('')}</ul>`)
      list = []
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!
    const heading = /^(#{1,2})\s+(.+)$/.exec(current)
    const item = /^-\s+(.+)$/.exec(current)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1]!.length
      output.push(`<h${level}>${inline(heading[2]!, file, index + 1)}</h${level}>`)
    } else if (item) {
      flushParagraph()
      if (list.length === 0) listStart = index + 1
      list.push(item[1]!)
    } else if (current.trim() === '') {
      flushParagraph()
      flushList()
    } else {
      flushList()
      if (paragraph.length === 0) paragraphStart = index + 1
      paragraph.push(current)
    }
  }
  flushParagraph()
  flushList()
  return output.join('\n')
}
