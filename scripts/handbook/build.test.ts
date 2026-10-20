import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHandbook, discoverHandbook, findScreenshotPairErrors, readPngDimensions, registerOutputDestination, resolveOutputDirectory, verifyReferences, MIN_SCREENSHOTS } from './build'

const roots: string[] = []

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'outbox-handbook-test-'))
  roots.push(path)
  return path
}

function png(size = 1001): Buffer {
  const data = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  data.write('IHDR', 12, 'ascii')
  data.writeUInt32BE(760, 16)
  data.writeUInt32BE(900, 20)
  return data
}

function writeDiscoveryFixture(root: string, screenshotCount: number): string {
  const screenshots = join(root, 'screenshots')
  for (let index = 0; index < 4; index += 1) {
    const group = join(screenshots, `chapter-${index}`)
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), `# Chapter ${index}\n`)
  }
  for (let index = 0; index < screenshotCount; index += 1) {
    const group = join(screenshots, `chapter-${index % 4}`)
    const name = `${String(index).padStart(2, '0')}-page`
    writeFileSync(join(group, `${name}.png`), png())
    writeFileSync(join(group, `${name}.md`), `# Page ${index}\n`)
  }
  return screenshots
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('handbook build discovery', () => {
  it('reports both missing image and missing text pairs', () => {
    const root = tempRoot()
    const group = join(root, 'screenshots', 'chapter')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), '# Chapter\n\nIntro')
    writeFileSync(join(group, '01-no-image.md'), '# Missing image\n\nText')
    expect(() => discoverHandbook(join(root, 'screenshots'))).toThrow(/matching \.png is missing/)
  })

  it('discovers a PNG without matching Markdown and reports it from the directory scan', () => {
    const root = tempRoot()
    const group = join(root, 'screenshots', 'chapter')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), '# Chapter\n')
    writeFileSync(join(group, '01-image.png'), png())

    expect(() => discoverHandbook(join(root, 'screenshots'), { minScreenshots: 0, minGroups: 0 }))
      .toThrow(/01-image\.png: matching \.md is missing/)
  })

  it('rejects a group that has only _group.md', () => {
    const root = tempRoot()
    const group = join(root, 'screenshots', 'chapter')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), '# Chapter\n')

    expect(() => discoverHandbook(join(root, 'screenshots'), { minScreenshots: 0, minGroups: 0 }))
      .toThrow(/group has no screenshots/)
  })

  it('rejects screenshot names that collide after case folding', () => {
    expect(findScreenshotPairErrors(
      ['01-a.png', '01-A.png'],
      ['01-a.md'],
      'screenshots/chapter',
    )).toContainEqual(expect.stringContaining('duplicate image names after case folding'))

    expect(findScreenshotPairErrors(
      ['01-a.png'],
      ['01-a.md', '01-A.md'],
      'screenshots/chapter',
    )).toContainEqual(expect.stringContaining('duplicate text names after case folding'))
  })

  it('requires each screenshot group to include its _group.md file', () => {
    const root = tempRoot()
    const group = join(root, 'screenshots', 'chapter')
    mkdirSync(group, { recursive: true })
    expect(() => discoverHandbook(join(root, 'screenshots'), { minScreenshots: 0, minGroups: 0 }))
      .toThrow(`${join(group, '_group.md')}: required group text is missing`)
  })

  it('enforces the screenshot floor at one below and exactly the configured minimum', () => {
    const below = tempRoot()
    expect(() => discoverHandbook(writeDiscoveryFixture(below, MIN_SCREENSHOTS - 1)))
      .toThrow(`Screenshot floor not met: ${MIN_SCREENSHOTS - 1} < ${MIN_SCREENSHOTS}`)
    const exact = tempRoot()
    expect(discoverHandbook(writeDiscoveryFixture(exact, MIN_SCREENSHOTS)).screenshots).toHaveLength(MIN_SCREENSHOTS)
  })

  it('enforces the configured group floor', () => {
    const root = tempRoot()
    const screenshots = join(root, 'screenshots')
    const group = join(screenshots, 'chapter')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), '# Chapter\n')
    writeFileSync(join(group, '01-page.png'), png())
    writeFileSync(join(group, '01-page.md'), '# Titel\n')

    expect(() => discoverHandbook(screenshots, { minScreenshots: 0, minGroups: 2 }))
      .toThrow('Group floor not met: 1 < 2')
    expect(() => discoverHandbook(screenshots, { minScreenshots: 0, minGroups: 1 })).not.toThrow()
  })

  it('checks both directions of the case-insensitive image and text pairing rule', () => {
    expect(findScreenshotPairErrors(['01-A.PNG'], ['01-a.md'], 'screenshots/group')).toEqual([])
    expect(findScreenshotPairErrors(['01-image.png'], ['02-text.md'], 'screenshots/group')).toEqual([
      'screenshots/group/01-image.png: matching .md is missing',
      'screenshots/group/02-text.md: matching .png is missing'
    ])
  })

  it('checks PNG signature and minimum size before reading dimensions', () => {
    const valid = png()
    expect(readPngDimensions(valid)).toEqual({ width: 760, height: 900 })
    expect(() => readPngDimensions(Buffer.alloc(1001))).toThrow(/PNG signature/)
    expect(() => readPngDimensions(png(500))).toThrow(/file is too small/)
    const missingHeader = png()
    missingHeader.fill(0, 12, 16)
    expect(() => readPngDimensions(missingHeader)).toThrow('PNG has no IHDR header')
  })

  it('rejects an output directory inside the repository and its ancestors', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    expect(() => resolveOutputDirectory(join(repo, 'build'), repo)).toThrow(/outside the repository/)
    expect(() => resolveOutputDirectory(root, repo)).toThrow(/outside the repository/)
    expect(() => resolveOutputDirectory(homedir(), repo)).toThrow(/outside the repository/)
  })

  it('rejects stale screenshot captures in a temporary repository', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const group = join(repo, 'docs/handbook/screenshots/chapter')
    mkdirSync(group, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeFileSync(join(repo, 'docs/handbook/screenshots/capture.json'), JSON.stringify({ htmlSha256: 'stale-hash' }))
    writeFileSync(join(group, '_group.md'), '# Chapter\n')
    writeFileSync(join(group, '01-page.png'), png())
    writeFileSync(join(group, '01-page.md'), '# Page\n')
    expect(() => buildHandbook(repo, join(root, 'output'))).toThrow('screenshots are stale')
  })

  it('rejects duplicate output paths and reports both source files', () => {
    const destinations = new Map<string, string>()
    registerOutputDestination(destinations, 'screenshots/chapter/01.png', '01-a.png')
    expect(() => registerOutputDestination(destinations, 'screenshots/chapter/01.png', '01-A.PNG'))
      .toThrow('Duplicate output screenshots/chapter/01.png from 01-a.png and 01-A.PNG')
  })

  it('rejects missing files, traversal paths, and missing anchors in generated references', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'present.png'), 'image')
    expect(() => verifyReferences('<a href="missing.png">x</a><a href="../escape">y</a><a href="#absent">z</a>', root))
      .toThrow(/missing local file missing.png[\s\S]*unsafe local reference \.\.\/escape[\s\S]*missing anchor #absent/)
    expect(() => verifyReferences('<div id="ok"></div><img src="present.png"><a href="#ok">x</a>', root)).not.toThrow()
  })

  it('accepts a temporary output directory outside the repository', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const output = join(root, 'built')
    mkdirSync(repo)
    expect(resolveOutputDirectory(output, repo)).toBe(join(realpathSync(root), 'built'))
  })

  it('resolves a non-existent output directly under the filesystem root', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const output = `/outbox-root-output-${process.pid}`

    expect(resolveOutputDirectory(output, repo)).toBe(output)
  })

  it('builds one escaped h3 per screenshot and uses screenshot titles in the contents', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    const htmlSource = 'export const handbook = true\n'
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'src/assets/fonts'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), htmlSource)
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeFileSync(join(repo, 'docs/handbook/screenshots/capture.json'), JSON.stringify({
      htmlSha256: createHash('sha256').update(htmlSource).digest('hex')
    }))
    for (const font of ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Inter-Bold.woff2']) {
      writeFileSync(join(repo, 'src/assets/fonts', font), `font:${font}`)
    }
    writeFileSync(join(repo, 'src/assets/fonts/Inter-LICENSE.txt'), 'OFL license')
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n\nChapter introduction.')

    const png = Buffer.alloc(1001)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(760, 16)
    png.writeUInt32BE(120, 20)
    writeFileSync(join(screenshots, '01-first.png'), png)
    writeFileSync(join(screenshots, '01-first.md'), '# First <view>\n\nDescription **one**.')
    writeFileSync(join(screenshots, '02-second.png'), png)
    writeFileSync(join(screenshots, '02-second.md'), '# Second view\n\nDescription two.')

    const { outputDir, manifest } = buildHandbook(repo, join(root, 'output'), { minScreenshots: 0, minGroups: 0 })
    const html = readFileSync(join(outputDir, 'index.html'), 'utf8')
    const css = readFileSync(join(outputDir, 'handbook.css'), 'utf8')
    const manifestFonts = manifest.artifacts.filter((artifact) => artifact.category === 'font')
    const manifestLicense = manifest.artifacts.find((artifact) => artifact.category === 'license')
    expect([...html.matchAll(/<h3>/g)]).toHaveLength(2)
    expect(html).toContain('<h3>First &lt;view&gt;</h3>')
    expect(html).toContain('<h3>Second view</h3>')
    expect(html).toContain('>First &lt;view&gt;</a>')
    expect(html).toContain('>Second view</a>')
    expect(html).toContain('<strong>one</strong>')
    expect([...html.matchAll(/<h1\b/g)]).toHaveLength(1)
    expect(html).toContain("font-src 'self'")
    expect(css).toContain('assets/fonts/Inter-Regular.woff2')
    expect(manifestFonts.map((font) => font.outputPath)).toEqual([
      'assets/fonts/Inter-Bold.woff2',
      'assets/fonts/Inter-Regular.woff2',
      'assets/fonts/Inter-SemiBold.woff2'
    ])
    expect(manifestLicense?.outputPath).toBe('assets/fonts/Inter-LICENSE.txt')
    for (const font of manifestFonts) {
      expect(readFileSync(join(outputDir, font.outputPath), 'utf8')).toBe(
        readFileSync(join(repo, font.source), 'utf8')
      )
    }
  })

  it('uses production screenshot floors when buildHandbook options are omitted', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    const htmlSource = 'export const handbook = true\n'
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), htmlSource)
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeFileSync(join(repo, 'docs/handbook/screenshots/capture.json'), JSON.stringify({
      htmlSha256: createHash('sha256').update(htmlSource).digest('hex')
    }))
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n\nChapter introduction.')
    for (const name of ['01-first', '02-second']) {
      writeFileSync(join(screenshots, `${name}.png`), png())
      writeFileSync(join(screenshots, `${name}.md`), `# ${name}\n`)
    }

    expect(() => buildHandbook(repo, join(root, 'output')))
      .toThrow(`Screenshot floor not met: 2 < ${MIN_SCREENSHOTS}`)
  })

  it('preserves the existing output when a discovered PNG is invalid', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    const htmlSource = 'export const handbook = true\n'
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), htmlSource)
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeFileSync(join(repo, 'docs/handbook/screenshots/capture.json'), JSON.stringify({
      htmlSha256: createHash('sha256').update(htmlSource).digest('hex')
    }))
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n')
    writeFileSync(join(screenshots, '01-invalid.png'), png().fill(0, 12, 16))
    writeFileSync(join(screenshots, '01-invalid.md'), '# Invalid screenshot\n')
    const output = join(root, 'output')
    mkdirSync(output)
    writeFileSync(join(output, 'marker.txt'), 'keep this output')

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('PNG has no IHDR header')
    expect(readFileSync(join(output, 'marker.txt'), 'utf8')).toBe('keep this output')
  })
})
