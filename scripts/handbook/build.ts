import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from './markdown'

export const MIN_SCREENSHOTS = 41 // floor, raise with the set
export const MIN_GROUPS = 5 // floor, raise with the set

export type Screenshot = { group: string; name: string; title: string; description: string; image: string; text: string }
export type ScreenshotGroup = { name: string; title: string; intro: string; images: Screenshot[] }
export type DiscoveredHandbook = { groups: ScreenshotGroup[]; screenshots: Screenshot[] }
export type Artifact = { category: string; source: string; outputPath: string; sha256: string }
export type HandbookManifest = { generator: 'outbox-handbook'; manifestVersion: 1; artifacts: Artifact[] }

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function walkCaptureInputs(root: string, directory: string): string[] {
  if (!existsSync(join(root, directory))) return []
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name).split(sep).join('/')
    if (entry.isDirectory()) return walkCaptureInputs(root, path)
    return entry.isFile() && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

export function discoverCaptureInputs(repoRoot: string): string[] {
  return [...walkCaptureInputs(repoRoot, 'src'), ...walkCaptureInputs(repoRoot, 'review'), 'scripts/handbook/capture-install.mjs', 'scripts/handbook/capture.mjs'].sort((a, b) => a.localeCompare(b, 'en'))
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CAPTURE_INPUTS = discoverCaptureInputs(repositoryRoot)

function captureInputsSha256(repoRoot: string, inputs: string[]): string {
  const hash = createHash('sha256')
  for (const input of inputs) {
    hash.update(input).update('\0').update(readFileSync(join(repoRoot, input))).update('\0')
  }
  return hash.digest('hex')
}

export type ExchangeFileSystem = Pick<typeof fs, 'existsSync' | 'mkdtempSync' | 'renameSync' | 'rmSync'>

function files(directory: string): string[] {
  return readdirSync(directory).sort((a, b) => a.localeCompare(b, 'en'))
}

export function findScreenshotPairErrors(imageFiles: string[], markdownFiles: string[], groupDir: string): string[] {
  const stem = (name: string) => name.slice(0, -extname(name).length).toLowerCase()
  const imageByStem = new Map(imageFiles.map((name) => [stem(name), name]))
  const textByStem = new Map(markdownFiles.map((name) => [stem(name), name]))
  const errors: string[] = []
  if (imageByStem.size !== imageFiles.length) errors.push(`${groupDir}: duplicate image names after case folding`)
  if (textByStem.size !== markdownFiles.length) errors.push(`${groupDir}: duplicate text names after case folding`)
  for (const [key, image] of imageByStem) if (!textByStem.has(key)) errors.push(`${join(groupDir, image)}: matching .md is missing`)
  for (const [key, text] of textByStem) if (!imageByStem.has(key)) errors.push(`${join(groupDir, text)}: matching .png is missing`)
  return errors
}

export function discoverHandbook(
  screenshotsDir: string,
  floors: { minScreenshots?: number; minGroups?: number } = {}
): DiscoveredHandbook {
  const minScreenshots = floors.minScreenshots ?? MIN_SCREENSHOTS
  const minGroups = floors.minGroups ?? MIN_GROUPS
  const errors: string[] = []
  const groups: ScreenshotGroup[] = []
  for (const groupName of files(screenshotsDir)) {
    const groupDir = join(screenshotsDir, groupName)
    if (!statSync(groupDir).isDirectory()) continue
    const entries = files(groupDir)
    const groupFile = join(groupDir, '_group.md')
    if (!entries.includes('_group.md')) {
      errors.push(`${groupFile}: required group text is missing`)
      continue
    }
    const imageFiles = entries.filter((name) => extname(name).toLowerCase() === '.png')
    const markdownFiles = entries.filter((name) => extname(name).toLowerCase() === '.md' && name.toLowerCase() !== '_group.md')
    errors.push(...findScreenshotPairErrors(imageFiles, markdownFiles, groupDir))
    const imageByStem = new Map(imageFiles.map((name) => [name.slice(0, -extname(name).length).toLowerCase(), name]))
    const textByStem = new Map(markdownFiles.map((name) => [name.slice(0, -extname(name).length).toLowerCase(), name]))
    const groupSource = readFileSync(groupFile, 'utf8')
    const title = parseHeadingTitle(groupSource.split(/\r?\n/, 1)[0] ?? '')
    if (!title) errors.push(`${groupFile}: first line must be a chapter title beginning with #`)
    const images: Screenshot[] = []
    for (const [stem, imageName] of imageByStem) {
      const textName = textByStem.get(stem)
      if (!textName) continue
      const text = join(groupDir, textName)
      const content = readFileSync(text, 'utf8')
      const lines = content.split(/\r?\n/)
      const screenshotTitle = parseHeadingTitle(lines[0] ?? '')
      if (!screenshotTitle) {
        errors.push(`${text}: first line must be a title beginning with #`)
        continue
      }
      images.push({ group: groupName, name: imageName.slice(0, -extname(imageName).length), title: screenshotTitle, description: lines.slice(1).join('\n'), image: join(groupDir, imageName), text })
    }
    if (imageFiles.length === 0) errors.push(`${groupDir}: group has no screenshots`)
    groups.push({ name: groupName, title: title ?? groupName, intro: groupSource, images })
  }
  if (errors.length) throw new Error(`Handbook discovery failed:\n${errors.sort().map((line) => `- ${line}`).join('\n')}`)
  const screenshots = groups.flatMap((group) => group.images)
  if (screenshots.length < minScreenshots) throw new Error(`Screenshot floor not met: ${screenshots.length} < ${minScreenshots}`)
  if (groups.length < minGroups) throw new Error(`Group floor not met: ${groups.length} < ${minGroups}`)
  return { groups, screenshots }
}

function parseHeadingTitle(line: string): string | undefined {
  return /^#\s+(.+?)\s*$/.exec(line)?.[1]?.trim() || undefined
}

export function resolveOutputDirectory(outputDir: string, repoRoot: string): string {
  const repo = realpathSync(repoRoot)
  let cursor = resolve(outputDir)
  const suffix: string[] = []
  while (true) {
    try {
      const actual = realpathSync(cursor)
      cursor = resolve(actual, ...suffix.reverse())
      break
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error(`Cannot resolve output directory: ${outputDir}`)
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
  const normalized = resolve(cursor)
  const rel = relative(repo, normalized)
  const home = realpathSync(homedir())
  const repoAncestorRel = relative(normalized, repo)
  const isRepoAncestor = repoAncestorRel === '' || (!repoAncestorRel.startsWith(`..${sep}`) && repoAncestorRel !== '..')
  if (normalized === '/' || normalized === home || isRepoAncestor || rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
    throw new Error('Output directory must be outside the repository, its ancestors, and the home directory')
  }
  return normalized
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/\"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plainMarkdown(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|`/g, '').trim()
}

export function readPngDimensions(data: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (data.length <= 1000 || !data.subarray(0, 8).equals(signature)) throw new Error('PNG signature is invalid or file is too small')
  if (data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG has no IHDR header')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function stylesheet(): string {
  return `@font-face{font-family:Inter;src:url("assets/fonts/Inter-Regular.woff2") format("woff2");font-style:normal;font-weight:400;font-display:swap}
@font-face{font-family:Inter;src:url("assets/fonts/Inter-SemiBold.woff2") format("woff2");font-style:normal;font-weight:600;font-display:swap}
@font-face{font-family:Inter;src:url("assets/fonts/Inter-Bold.woff2") format("woff2");font-style:normal;font-weight:700;font-display:swap}
:root{color-scheme:light;--bg:#f6f8fc;--surface:#fff;--surface-soft:#eef3fa;--text:#0b1426;--text-secondary:#566174;--text-muted:#8d98aa;--border:#dde5f0;--primary:#1e6ef7;--primary-soft:#e6f0ff;--link:#174ea6;--success:#16a34a;--warning:#8a5a00;--error:#dc2626;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;--radius-sm:6px;--radius-md:10px;--radius-lg:16px;--shadow-card:0 6px 20px rgba(11,20,38,.05)}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg);font:16px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}main{max-width:1100px;margin:0 auto;padding:var(--space-6) var(--space-5)}
.brand{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5);color:var(--text-secondary);font-size:14px;font-weight:600}.brand svg{display:block;width:77px;height:24px}
nav,article,figure{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-card);padding:var(--space-5);margin:var(--space-4) 0}nav ul{columns:2;column-gap:var(--space-6)}nav li{break-inside:avoid;margin:0 0 var(--space-2)}a{color:var(--link);text-underline-offset:3px}article{max-width:70ch}figure{margin-top:var(--space-4)}img{display:block;width:100%;max-width:100%;height:auto;border-radius:var(--radius-md)}figcaption{max-width:70ch;margin:var(--space-4) auto 0}h1,h2,h3{line-height:1.25;letter-spacing:-.02em}h1{font-size:30px}h2{font-size:22px}code{background:var(--surface-soft);padding:.1em .3em;border-radius:var(--radius-sm)}
@media(max-width:640px){main{padding:var(--space-4)}nav,article,figure{padding:var(--space-4)}nav ul{columns:1}}`
}

export function verifyReferences(html: string, outputDir: string): void {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))
  const errors: string[] = []
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const value = match[1]!
    if (value.startsWith('https://')) continue
    if (value.startsWith('#')) {
      if (!ids.has(value.slice(1))) errors.push(`missing anchor ${value}`)
      continue
    }
    let decoded: string
    try { decoded = decodeURIComponent(value) } catch { errors.push(`invalid local reference ${value}`); continue }
    if (decoded.includes('..') || decoded.startsWith('/') || decoded.includes('\\')) {
      errors.push(`unsafe local reference ${value}`)
      continue
    }
    const target = resolve(outputDir, decoded)
    const rel = relative(outputDir, target)
    if (rel.startsWith(`..${sep}`) || rel === '..' || !statExists(target)) errors.push(`missing local file ${value}`)
  }
  if (errors.length) throw new Error(`Output references failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
}

function statExists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

function isPreviousHandbookBuild(outputDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as {
      generator?: unknown
      manifestVersion?: unknown
      artifacts?: Array<{ outputPath?: unknown }>
    }
    if (manifest.generator !== 'outbox-handbook' || manifest.manifestVersion !== 1 || !Array.isArray(manifest.artifacts)) return false
    const artifactPaths = new Set(manifest.artifacts.map((artifact) => artifact?.outputPath).filter((path): path is string => typeof path === 'string'))
    if (!artifactPaths.has('index.html')) return false
    const actualFiles: string[] = []
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) visit(join(directory, entry.name), path)
        else if (entry.isFile()) actualFiles.push(path)
        else throw new Error('Unexpected non-file entry')
      }
    }
    visit(outputDir)
    return actualFiles.every((path) => path === 'manifest.json' || artifactPaths.has(path))
  } catch {
    return false
  }
}

export function registerOutputDestination(destinations: Map<string, string>, outputPath: string, source: string): void {
  const prior = destinations.get(outputPath)
  if (prior) throw new Error(`Duplicate output ${outputPath} from ${prior} and ${source}`)
  destinations.set(outputPath, source)
}

export function buildHandbook(
  repoRoot: string,
  requestedOutput: string,
  options: { minScreenshots?: number; minGroups?: number; fs?: ExchangeFileSystem } = {}
): { outputDir: string; manifest: HandbookManifest } {
  const exchangeFs = options.fs ?? fs
  let requestedStat: ReturnType<typeof lstatSync> | undefined
  try { requestedStat = lstatSync(resolve(requestedOutput)) } catch {}
  if (requestedStat?.isSymbolicLink()) throw new Error(`Output directory must not be a symlink: ${resolve(requestedOutput)}`)
  const outputDir = resolveOutputDirectory(requestedOutput, repoRoot)
  let outputStat: ReturnType<typeof lstatSync> | undefined
  try { outputStat = lstatSync(outputDir) } catch {}
  if (outputStat) {
    if (outputStat.isSymbolicLink()) throw new Error(`Output directory must not be a symlink: ${outputDir}`)
    if (!statSync(outputDir).isDirectory()) throw new Error(`Output path is not a directory: ${outputDir}`)
    const contents = readdirSync(outputDir)
    if (contents.length > 0) {
      if (!isPreviousHandbookBuild(outputDir)) throw new Error(`Refusing to replace non-empty directory that is not a handbook build: ${outputDir}`)
    }
  }
  const capturePath = join(repoRoot, 'docs/handbook/screenshots/capture.json')
  let capture: { inputs?: string[]; inputsSha256?: string }
  try {
    capture = JSON.parse(readFileSync(capturePath, 'utf8')) as { inputs?: string[]; inputsSha256?: string }
  } catch {
    throw new Error('screenshots are stale, run the capture')
  }
  const captureInputs = discoverCaptureInputs(repoRoot)
  if (JSON.stringify(capture.inputs) !== JSON.stringify(captureInputs) || capture.inputsSha256 !== captureInputsSha256(repoRoot, captureInputs)) {
    throw new Error('screenshots are stale, run the capture')
  }
  const discovered = discoverHandbook(join(repoRoot, 'docs/handbook/screenshots'), options)
  const fontSourceDir = join(repoRoot, 'src/assets/fonts')
  const fontFiles = existsSync(fontSourceDir)
    ? readdirSync(fontSourceDir, { withFileTypes: true }).filter((entry) => entry.isFile() && (entry.name.endsWith('.woff2') || entry.name === 'Inter-LICENSE.txt')).map((entry) => entry.name).sort()
    : []
  mkdirSync(dirname(outputDir), { recursive: true })
  let temporaryDir = exchangeFs.mkdtempSync(join(dirname(outputDir), `.${basename(outputDir)}-tmp-`))
  const backupCandidate = () => exchangeFs.mkdtempSync(join(dirname(outputDir), `.${basename(outputDir)}-backup-`))
  try {
    return buildInDirectory(repoRoot, outputDir, temporaryDir, discovered, fontSourceDir, fontFiles, backupCandidate, exchangeFs)
  } catch (error) {
    if (temporaryDir && exchangeFs.existsSync(temporaryDir)) exchangeFs.rmSync(temporaryDir, { recursive: true, force: true })
    throw error
  }
}

function buildInDirectory(
  repoRoot: string,
  outputDir: string,
  temporaryDir: string,
  discovered: DiscoveredHandbook,
  fontSourceDir: string,
  fontFiles: string[],
  backupCandidate: () => string,
  exchangeFs: ExchangeFileSystem
): { outputDir: string; manifest: HandbookManifest } {
  mkdirSync(join(temporaryDir, 'screenshots'), { recursive: true })
  const artifacts: Artifact[] = []
  const destinations = new Map<string, string>()
  const addArtifact = (category: string, source: string, outputPath: string, data: Buffer) => {
    registerOutputDestination(destinations, outputPath, source)
    const destination = join(temporaryDir, outputPath)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, data)
    artifacts.push({ category, source: relative(repoRoot, source).split(sep).join('/'), outputPath, sha256: sha256(data) })
  }
  const introPath = join(repoRoot, 'docs/handbook/intro.md')
  const introHtml = renderMarkdown(readFileSync(introPath, 'utf8'), introPath)
  for (const fontFile of fontFiles) {
    const category = fontFile.endsWith('.woff2') ? 'font' : 'license'
    addArtifact(category, join(fontSourceDir, fontFile), `assets/fonts/${fontFile}`, readFileSync(join(fontSourceDir, fontFile)))
  }
  const toc = discovered.groups.map((group) => `<li><a href="#${safeId(group.name)}">${escapeAttribute(group.title)}</a><ul>${group.images.map((image) => `<li><a href="#${safeId(`${group.name}-${image.name}`)}">${escapeAttribute(image.title)}</a></li>`).join('')}</ul></li>`).join('')
  const sections = discovered.groups.map((group) => {
    const groupTitle = group.title
    const groupIntro = group.intro.split(/\r?\n/).slice(1).join('\n')
    const figures = group.images.map((image) => {
      const imagePath = `screenshots/${group.name}/${image.name}${extname(image.image).toLowerCase()}`
      const imageUrl = imagePath.split('/').map((part) => encodeURIComponent(part)).join('/')
      const data = readFileSync(image.image)
      const size = readPngDimensions(data)
      addArtifact('screenshot', image.image, imagePath, data)
      return `<figure id="${safeId(`${group.name}-${image.name}`)}"><img src="${imageUrl}" alt="${escapeAttribute(plainMarkdown(`${image.title}. ${image.description}`))}" width="${size.width}" height="${size.height}"><figcaption><h3>${escapeAttribute(image.title)}</h3>${renderMarkdown(image.description, image.text)}</figcaption></figure>`
    }).join('\n')
    return `<section id="${safeId(group.name)}"><h2>${escapeAttribute(groupTitle)}</h2>${renderMarkdown(groupIntro, join(repoRoot, 'docs/handbook/screenshots', group.name, '_group.md'))}${figures}</section>`
  }).join('\n')
  const logo = '<svg viewBox="0 0 544 170" role="img" aria-label="DFX" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#dfx-handbook-clip)"><path fill-rule="evenodd" clip-rule="evenodd" d="M61.5031 0H124.245C170.646 0 208.267 36.5427 208.267 84.0393C208.267 131.536 169.767 170.018 122.288 170.018H61.5031V135.504H114.046C141.825 135.504 164.541 112.789 164.541 85.009C164.541 57.2293 141.825 34.5136 114.046 34.5136H61.5031V0ZM266.25 31.5686V76.4973H338.294V108.066H266.25V170H226.906V0H355.389V31.5686H266.25ZM495.76 170L454.71 110.975L414.396 170H369.216L432.12 83.5365L372.395 0H417.072L456.183 55.1283L494.557 0H537.061L477.803 82.082L541.191 170H495.778H495.76Z" fill="#072440"/><path d="M86.1582 126.274C109.821 126.274 129.004 107.092 129.004 83.4287C129.004 59.7657 109.821 40.583 86.1582 40.583C62.4952 40.583 43.3126 59.7657 43.3126 83.4287C43.3126 107.092 62.4952 126.274 86.1582 126.274Z" fill="url(#dfx-handbook-p0)"/><path d="M47.1374 132.146C73.1707 132.146 94.2748 111.042 94.2748 85.009C94.2748 58.9757 73.1707 37.8716 47.1374 37.8716C21.1041 37.8716 0 58.9757 0 85.009C0 111.042 21.1041 132.146 47.1374 132.146Z" fill="url(#dfx-handbook-p1)"/></g><defs><linearGradient id="dfx-handbook-p0" x1="122.111" y1="64.6777" x2="45.9618" y2="103.949" gradientUnits="userSpaceOnUse"><stop offset=".04" stop-color="#F5516C"/><stop offset=".14" stop-color="#C74863"/><stop offset=".31" stop-color="#853B57"/><stop offset=".44" stop-color="#55324E"/><stop offset=".55" stop-color="#382D49"/><stop offset=".61" stop-color="#2D2B47"/></linearGradient><linearGradient id="dfx-handbook-p1" x1="75.8868" y1="50.7468" x2="15.2815" y2="122.952" gradientUnits="userSpaceOnUse"><stop offset=".2" stop-color="#F5516C"/><stop offset="1" stop-color="#6B3753"/></linearGradient><clipPath id="dfx-handbook-clip"><rect width="541.174" height="170" fill="white"/></clipPath></defs></svg>'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"><title>Outbox handbook</title><link rel="stylesheet" href="handbook.css"></head><body><main><header class="brand">${logo}<span>Outbox handbook</span></header><nav aria-label="Contents"><h2>Contents</h2><ul>${toc}</ul></nav><article>${introHtml}</article>${sections}</main></body></html>`
  writeFileSync(join(temporaryDir, 'handbook.css'), stylesheet())
  writeFileSync(join(temporaryDir, 'index.html'), html)
  verifyReferences(html, temporaryDir)
  artifacts.push({ category: 'handbook', source: 'docs/handbook/intro.md', outputPath: 'index.html', sha256: sha256(html) })
  artifacts.push({ category: 'style', source: 'scripts/handbook/build.ts', outputPath: 'handbook.css', sha256: sha256(readFileSync(join(temporaryDir, 'handbook.css'))) })
  for (const artifact of artifacts) {
    if (!statExists(join(temporaryDir, artifact.outputPath))) throw new Error(`Manifest artifact is missing: ${artifact.outputPath}`)
  }
  const manifest: HandbookManifest = { generator: 'outbox-handbook', manifestVersion: 1, artifacts }
  writeFileSync(join(temporaryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  let backupDir: string | null = null
  if (exchangeFs.existsSync(outputDir)) {
    backupDir = backupCandidate()
    exchangeFs.rmSync(backupDir, { recursive: true, force: true })
    exchangeFs.renameSync(outputDir, backupDir)
  }
  try {
    exchangeFs.renameSync(temporaryDir, outputDir)
    temporaryDir = ''
  } catch (error) {
    if (backupDir && exchangeFs.existsSync(backupDir)) {
      try {
        exchangeFs.renameSync(backupDir, outputDir)
      } catch (restoreError) {
        throw new Error(`Failed to replace output and restore backup; output path: ${outputDir}; backup path: ${backupDir}; replacement error: ${error instanceof Error ? error.message : String(error)}; restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
      }
    }
    throw error
  }
  if (backupDir) {
    try {
      exchangeFs.rmSync(backupDir, { recursive: true, force: true })
    } catch (error) {
      process.stderr.write(`Warning: handbook built successfully, but could not remove backup ${backupDir}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { outputDir, manifest }
}

export function main(): void {
  const output = process.argv[2]
  if (!output) throw new Error('Usage: build.ts <outDir>')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const result = buildHandbook(repoRoot, output)
  process.stdout.write(`Built ${result.manifest.artifacts.length} artifacts in ${result.outputDir}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
