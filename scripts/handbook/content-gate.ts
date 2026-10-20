import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const QR_ALLOWLIST: Record<string, RegExp[]> = {} // Entries require a relative image path and payload patterns; validate entries both ways.
// The shortest real page has exactly two words of at least four letters.
export const MIN_OCR_TOKENS_PER_IMAGE = 2
export const MIN_OCR_TOKENS_TOTAL = 300 // floor, raise with the set
// Chromium's empty datetime-local control contributes this browser placeholder token.
export const BROWSER_UI_TOKENS = new Set(['yyyy'])

export type Manifest = { artifacts: Array<{ category: string; outputPath: string }> }
export type GateProblem = { image: string; message: string }

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

export function comparePngSets(manifestPaths: string[], diskPaths: string[]): string[] {
  const normalize = (path: string) => path.split(sep).join('/').toLowerCase()
  const fromManifest = new Set(manifestPaths.filter((path) => extname(path).toLowerCase() === '.png').map(normalize))
  const fromDisk = new Set(diskPaths.filter((path) => extname(path).toLowerCase() === '.png').map(normalize))
  const differences: string[] = []
  for (const path of fromManifest) if (!fromDisk.has(path)) differences.push(`manifest image missing on disk: ${path}`)
  for (const path of fromDisk) if (!fromManifest.has(path)) differences.push(`unmanifested image on disk: ${path}`)
  if (fromManifest.size === 0) differences.push('the built image set is empty')
  return differences.sort()
}

export function validateQrAllowlist(allowlist: Record<string, RegExp[]>, imagePaths: string[], decoded: Record<string, string[]>): string[] {
  const normalize = (path: string) => path.split(sep).join('/').toLowerCase()
  const imageSet = new Set(imagePaths.map(normalize))
  const allowlistByPath = new Map(Object.entries(allowlist).map(([path, patterns]) => [normalize(path), patterns]))
  const decodedByPath = new Map(Object.entries(decoded).map(([path, payloads]) => [normalize(path), payloads]))
  const errors: string[] = []
  for (const [path, patterns] of Object.entries(allowlist)) {
    const key = normalize(path)
    if (!imageSet.has(key)) errors.push(`QR allowlist entry has no image: ${path}`)
    if (!patterns.length) errors.push(`QR allowlist entry has no payload patterns: ${path}`)
    if (!(decodedByPath.get(key) ?? []).length) errors.push(`QR allowlist entry has no QR payload: ${path}`)
  }
  for (const [path, payloads] of Object.entries(decoded)) {
    const patterns = allowlistByPath.get(normalize(path))
    for (const payload of payloads) {
      if (!patterns?.some((pattern) => pattern.test(payload))) errors.push(`unexpected QR payload in ${path}: ${payload}`)
    }
  }
  return errors.sort()
}

export function tokenize(text: string): string[] {
  return text.toLocaleLowerCase('en').match(/\p{L}+/gu)?.filter((token) => token.length >= 4) ?? []
}

export function levenshteinAtMostOne(left: string, right: string): boolean {
  if (left === right) return true
  if (Math.abs(left.length - right.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue }
    edits += 1
    if (edits > 1) return false
    if (left.length > right.length) i += 1
    else if (right.length > left.length) j += 1
    else { i += 1; j += 1 }
  }
  return edits + Number(i < left.length || j < right.length) <= 1
}

export function findUnexpectedTokens(image: string, text: string, vocabulary: Set<string>): string[] {
  const words = [...vocabulary].filter((word) => word.length >= 5)
  return [...new Set(tokenize(text))].filter((token) =>
    !vocabulary.has(token) && !words.some((word) => levenshteinAtMostOne(token, word))
  ).map((token) => `${image}: unexpected OCR token "${token}"`)
}

export function findSensitiveText(image: string, text: string): string[] {
  const errors: string[] = []
  if (/\beyJ[A-Za-z0-9_-]{12,}\b/.test(text)) errors.push(`${image}: JWT-like text detected`)
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) errors.push(`${image}: email address detected`)
  if (/(?:\b[0-9a-f]{24,}\b|\b[A-Za-z0-9+/]{24,}={0,2}\b)/i.test(text)) errors.push(`${image}: long encoded value detected`)
  for (const match of text.matchAll(/https?:\/\/([^\s/]+)/gi)) {
    if (match[1]!.toLowerCase() !== 'x.com') errors.push(`${image}: URL host is not allowed: ${match[1]}`)
  }
  return errors
}

export type ToolResult = { status: number | null; stdout: string; stderr: string; error?: Error }

function defaultRunTool(name: string, args: string[]): ToolResult {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) }
}

function sourceVocabulary(repoRoot: string): Set<string> {
  const sourceFiles = [
    ...walk(join(repoRoot, 'src')).filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts')),
    ...walk(join(repoRoot, 'review')).filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
  ]
  const sourceContent = sourceFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
  const captureSource = readFileSync(join(repoRoot, 'scripts/handbook/capture.mjs'), 'utf8')
  const handbookText = walk(join(repoRoot, 'docs/handbook')).filter((path) => path.endsWith('.md')).map((path) => readFileSync(path, 'utf8')).join('\n')
  const literals: string[] = []
  const collectLiterals = (source: string) => {
    for (const match of source.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)) literals.push(match[1] ?? match[2] ?? '')
    for (const match of source.matchAll(/`([\s\S]*?)`/g)) literals.push(match[1]!.replace(/\$\{[^}]*\}/g, ' '))
  }
  collectLiterals(sourceContent)
  collectLiterals(captureSource)
  const months = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month, 1))))
  const weekdays = Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, day + 7))))
  return new Set([...tokenize([...literals, captureSource, handbookText, ...months, ...weekdays].join(' ')), ...BROWSER_UI_TOKENS])
}

export function gateBuiltHandbook(
  builtDir: string,
  repoRoot: string,
  runTool: (name: string, args: string[]) => ToolResult = defaultRunTool
): GateProblem[] {
  const resolvedBuiltDir = realpathSync(builtDir)
  const manifest = JSON.parse(readFileSync(join(resolvedBuiltDir, 'manifest.json'), 'utf8')) as Manifest
  const images = walk(join(resolvedBuiltDir, 'screenshots')).filter((path) => extname(path).toLowerCase() === '.png')
  const manifestImages = manifest.artifacts.filter((item) => extname(item.outputPath).toLowerCase() === '.png').map((item) => item.outputPath)
  const diskImages = images.map((path) => relative(resolvedBuiltDir, path))
  const setErrors = comparePngSets(manifestImages, diskImages)
  if (setErrors.length) return setErrors.map((message) => ({ image: 'manifest.json', message }))
  const vocabulary = sourceVocabulary(repoRoot)
  const problems: GateProblem[] = []
  const qrDecoded: Record<string, string[]> = {}
  let totalOcrTokens = 0
  for (const path of diskImages.sort()) {
    const fullPath = resolve(resolvedBuiltDir, path)
    const qr = runTool('zbarimg', ['--quiet', '--raw', fullPath])
    if (qr.error || qr.status === 127) throw new Error('zbarimg is required for the handbook content gate')
    if (qr.status !== 0 && qr.status !== 4) throw new Error(`zbarimg failed for ${path}: ${qr.stderr.trim()}`)
    qrDecoded[path] = qr.status === 0 ? qr.stdout.split(/\r?\n/).filter(Boolean) : []
    const ocr = runTool('tesseract', [fullPath, 'stdout'])
    if (ocr.error || ocr.status === 127) throw new Error('tesseract is required for the handbook content gate')
    if (ocr.status !== 0) throw new Error(`tesseract failed for ${path}: ${ocr.stderr.trim()}`)
    const tokens = tokenize(ocr.stdout)
    totalOcrTokens += tokens.length
    if (tokens.length < MIN_OCR_TOKENS_PER_IMAGE) {
      problems.push({ image: path, message: 'OCR yielded too little, the text check would be vacuous' })
    }
    for (const message of findUnexpectedTokens(path, ocr.stdout, vocabulary)) problems.push({ image: path, message })
    for (const message of findSensitiveText(path, ocr.stdout)) problems.push({ image: path, message })
  }
  if (totalOcrTokens < MIN_OCR_TOKENS_TOTAL) {
    problems.push({ image: 'screenshots', message: `OCR yielded ${totalOcrTokens} tokens across the set, below the minimum ${MIN_OCR_TOKENS_TOTAL}` })
  }
  for (const message of validateQrAllowlist(QR_ALLOWLIST, diskImages, qrDecoded)) problems.push({ image: 'screenshots', message })
  return problems
}

export function main(): void {
  const builtDir = process.argv[2]
  if (!builtDir) throw new Error('Usage: content-gate.ts <builtDir>')
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const problems = gateBuiltHandbook(resolve(builtDir), repoRoot)
  if (problems.length) throw new Error(problems.map((problem) => `- ${problem.image}: ${problem.message}`).join('\n'))
  process.stdout.write('Handbook content gate passed\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
