import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from './markdown'

export const MIN_SCREENSHOTS = 31 // floor, raise with the set
export const MIN_GROUPS = 4 // floor, raise with the set

export type Screenshot = { group: string; name: string; title: string; description: string; image: string; text: string }
export type ScreenshotGroup = { name: string; title: string; intro: string; images: Screenshot[] }
export type DiscoveredHandbook = { groups: ScreenshotGroup[]; screenshots: Screenshot[] }
export type Artifact = { category: string; source: string; outputPath: string; sha256: string }

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

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
    const title = /^#\s+(.+)\s*$/.exec(groupSource.split(/\r?\n/, 1)[0] ?? '')?.[1]
    if (!title) errors.push(`${groupFile}: first line must be a chapter title beginning with #`)
    const images: Screenshot[] = []
    for (const [stem, imageName] of imageByStem) {
      const textName = textByStem.get(stem)
      if (!textName) continue
      const text = join(groupDir, textName)
      const content = readFileSync(text, 'utf8')
      const lines = content.split(/\r?\n/)
      const title = /^#\s+(.+)$/.exec(lines[0] ?? '')?.[1]
      if (!title) {
        errors.push(`${text}: first line must be a title beginning with #`)
        continue
      }
      images.push({ group: groupName, name: imageName.slice(0, -extname(imageName).length), title, description: lines.slice(1).join('\n'), image: join(groupDir, imageName), text })
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
      suffix.push(cursor.slice(parent.length + 1))
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
  if (!isAbsolute(normalized)) throw new Error('Invalid output directory')
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
  return `*{box-sizing:border-box}body{margin:0;color:#172033;background:#f3f5f8;font:16px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:2rem}nav,article,figure{background:#fff;border:1px solid #d9e0ea;border-radius:12px;padding:1rem;margin:1rem 0}nav ul{columns:2}a{color:#174ea6}img{display:block;max-width:100%;height:auto;margin:auto}figcaption{margin-top:1rem}h1,h2{line-height:1.2}code{background:#edf0f4;padding:.1em .3em;border-radius:4px}@media(max-width:640px){main{padding:1rem}nav ul{columns:1}}`
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

export function registerOutputDestination(destinations: Map<string, string>, outputPath: string, source: string): void {
  const prior = destinations.get(outputPath)
  if (prior) throw new Error(`Duplicate output ${outputPath} from ${prior} and ${source}`)
  destinations.set(outputPath, source)
}

export function buildHandbook(
  repoRoot: string,
  requestedOutput: string,
  options: { minScreenshots?: number; minGroups?: number } = {}
): { outputDir: string; manifest: { artifacts: Artifact[] } } {
  const outputDir = resolveOutputDirectory(requestedOutput, repoRoot)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(join(outputDir, 'screenshots'), { recursive: true })
  const htmlSource = join(repoRoot, 'src/html.ts')
  const capturePath = join(repoRoot, 'docs/handbook/screenshots/capture.json')
  const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as { htmlSha256?: string }
  if (capture.htmlSha256 !== sha256(readFileSync(htmlSource))) throw new Error('screenshots are stale, run the capture')
  const discovered = discoverHandbook(join(repoRoot, 'docs/handbook/screenshots'), options)
  const artifacts: Artifact[] = []
  const destinations = new Map<string, string>()
  const addArtifact = (category: string, source: string, outputPath: string, data: Buffer) => {
    registerOutputDestination(destinations, outputPath, source)
    const destination = join(outputDir, outputPath)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, data)
    artifacts.push({ category, source: relative(repoRoot, source).split(sep).join('/'), outputPath, sha256: sha256(data) })
  }
  const introPath = join(repoRoot, 'docs/handbook/intro.md')
  const introHtml = renderMarkdown(readFileSync(introPath, 'utf8'), introPath)
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"><title>Outbox handbook</title><link rel="stylesheet" href="handbook.css"></head><body><main><header><h1>Outbox handbook</h1></header><nav aria-label="Contents"><h2>Contents</h2><ul>${toc}</ul></nav><article>${introHtml}</article>${sections}</main></body></html>`
  writeFileSync(join(outputDir, 'handbook.css'), stylesheet())
  writeFileSync(join(outputDir, 'index.html'), html)
  verifyReferences(html, outputDir)
  artifacts.push({ category: 'handbook', source: 'docs/handbook/intro.md', outputPath: 'index.html', sha256: sha256(html) })
  artifacts.push({ category: 'style', source: 'scripts/handbook/build.ts', outputPath: 'handbook.css', sha256: sha256(readFileSync(join(outputDir, 'handbook.css'))) })
  for (const artifact of artifacts) {
    if (!statExists(join(outputDir, artifact.outputPath))) throw new Error(`Manifest artifact is missing: ${artifact.outputPath}`)
  }
  const manifest = { artifacts }
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
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
