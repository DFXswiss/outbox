import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHandbook, discoverCaptureInputs, discoverHandbook, findScreenshotPairErrors, readPngDimensions, registerOutputDestination, resolveOutputDirectory, verifyReferences, MIN_GROUPS, MIN_SCREENSHOTS } from './build'

const roots: string[] = []

function tempRoot(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'outbox-handbook-test-')))
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

function writePreviousBuild(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ generator: 'outbox-handbook', manifestVersion: 1, artifacts: [{ outputPath: 'index.html' }, { outputPath: 'marker.txt' }] }))
  writeFileSync(join(dir, 'marker.txt'), 'keep this output')
}

function writeCaptureMetadata(repo: string): void {
  const inputs = discoverCaptureInputs(repo)
  const hash = createHash('sha256')
  for (const input of inputs) {
    const path = join(repo, input)
    mkdirSync(join(path, '..'), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, `fixture source for ${input}\n`)
    hash.update(input).update('\0').update(readFileSync(path)).update('\0')
  }
  writeFileSync(join(repo, 'docs/handbook/screenshots/capture.json'), JSON.stringify({ inputs, inputsSha256: hash.digest('hex') }))
}

function captureRepo(root: string): string {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'review'), { recursive: true })
  mkdirSync(join(repo, 'docs/handbook/screenshots/chapter'), { recursive: true })
  mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
  writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
  writeFileSync(join(repo, 'src/server.ts'), 'export const server = true\n')
  writeFileSync(join(repo, 'src/findings.ts'), 'export const findings = true\n')
  writeFileSync(join(repo, 'review/example.md'), '# Review\n')
  writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
  writeFileSync(join(repo, 'docs/handbook/screenshots/chapter/_group.md'), '# Chapter\n')
  writeFileSync(join(repo, 'docs/handbook/screenshots/chapter/01-page.png'), png())
  writeFileSync(join(repo, 'docs/handbook/screenshots/chapter/01-page.md'), '# Page\n')
  return repo
}

function writeDiscoveryFixture(root: string, screenshotCount: number): string {
  const screenshots = join(root, 'screenshots')
  for (let index = 0; index < MIN_GROUPS; index += 1) {
    const group = join(screenshots, `chapter-${index}`)
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, '_group.md'), `# Chapter ${index}\n`)
  }
  for (let index = 0; index < screenshotCount; index += 1) {
    const group = join(screenshots, `chapter-${index % MIN_GROUPS}`)
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
  it('discovers capture inputs from source and review trees while excluding tests', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    writeFileSync(join(repo, 'src/server.test.ts'), 'test')
    const inputs = discoverCaptureInputs(repo)
    expect(inputs).toEqual(expect.arrayContaining([
      'src/html.ts', 'src/server.ts', 'src/findings.ts', 'review/example.md', 'scripts/handbook/capture.mjs'
    ]))
    expect(inputs.some((input) => input.endsWith('.test.ts'))).toBe(false)
  })

  it.each(['src/html.ts', 'src/findings.ts', 'scripts/handbook/capture.mjs'])(
    'marks capture metadata stale after %s changes', (changedPath) => {
      const root = tempRoot()
      const repo = captureRepo(root)
      writeCaptureMetadata(repo)
      writeFileSync(join(repo, changedPath), 'changed after capture\n')
      expect(() => buildHandbook(repo, join(root, 'output'), { minScreenshots: 0, minGroups: 0 })).toThrow('screenshots are stale')
    }
  )

  it('refuses a non-empty output that is not a previous handbook build', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const output = join(root, 'documents')
    mkdirSync(output)
    writeFileSync(join(output, 'important.txt'), 'preserve me')
    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 })).toThrow('not a handbook build')
    expect(readFileSync(join(output, 'important.txt'), 'utf8')).toBe('preserve me')
  })

  it.each([
    ['an unrelated artifact', { artifacts: [{ outputPath: 'other.html' }] }],
    ['an empty artifact list', { artifacts: [] }],
  ])('refuses a non-empty output with a manifest containing %s', (_description, manifest) => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const output = join(root, 'documents')
    mkdirSync(output)
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(output, 'important.txt'), 'preserve me')

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('Refusing to replace non-empty directory that is not a handbook build')
    expect(readFileSync(join(output, 'manifest.json'), 'utf8')).toBe(JSON.stringify(manifest))
    expect(readFileSync(join(output, 'important.txt'), 'utf8')).toBe('preserve me')
  })

  it('preserves an unrelated directory with a forged handbook artifact entry', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const output = join(root, 'documents')
    mkdirSync(output)
    const manifest = JSON.stringify({ artifacts: [{ outputPath: 'index.html' }] })
    writeFileSync(join(output, 'manifest.json'), manifest)
    writeFileSync(join(output, 'important.txt'), 'preserve me')

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('Refusing to replace non-empty directory that is not a handbook build')
    expect(readFileSync(join(output, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(output, 'important.txt'), 'utf8')).toBe('preserve me')
  })

  it.each([
    ['a missing generator', { manifestVersion: 1, artifacts: [{ outputPath: 'index.html' }, { outputPath: 'marker.txt' }] }],
    ['an unrelated generator', { generator: 'other', manifestVersion: 1, artifacts: [{ outputPath: 'index.html' }, { outputPath: 'marker.txt' }] }],
    ['an unsupported manifest version', { generator: 'outbox-handbook', manifestVersion: 2, artifacts: [{ outputPath: 'index.html' }, { outputPath: 'marker.txt' }] }],
  ])('preserves a non-empty output with %s despite a complete artifact list', (_description, manifest) => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const output = join(root, 'documents')
    mkdirSync(output)
    const manifestContents = JSON.stringify(manifest)
    writeFileSync(join(output, 'manifest.json'), manifestContents)
    writeFileSync(join(output, 'index.html'), '<!doctype html><title>Existing handbook</title>')
    writeFileSync(join(output, 'marker.txt'), 'preserve me')

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('Refusing to replace non-empty directory that is not a handbook build')
    expect(readFileSync(join(output, 'manifest.json'), 'utf8')).toBe(manifestContents)
    expect(readFileSync(join(output, 'index.html'), 'utf8')).toBe('<!doctype html><title>Existing handbook</title>')
    expect(readFileSync(join(output, 'marker.txt'), 'utf8')).toBe('preserve me')
  })

  it('refuses a marked handbook output with an unlisted file', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const output = join(root, 'documents')
    writePreviousBuild(output)
    mkdirSync(join(output, 'extra'), { recursive: true })
    writeFileSync(join(output, 'extra', 'important.txt'), 'preserve me')

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('Refusing to replace non-empty directory that is not a handbook build')
    expect(readFileSync(join(output, 'marker.txt'), 'utf8')).toBe('keep this output')
    expect(readFileSync(join(output, 'extra', 'important.txt'), 'utf8')).toBe('preserve me')
  })

  it('replaces a previous handbook build output directory', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    writeCaptureMetadata(repo)
    const output = join(root, 'documents')
    buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 })
    const replacement = buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 })

    expect(replacement.outputDir).toBe(output)
    expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toMatchObject({
      generator: 'outbox-handbook',
      manifestVersion: 1
    })
    expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('Outbox handbook')
  })

  it('refuses a symlink output directory', () => {
    const root = tempRoot()
    const repo = captureRepo(root)
    const target = join(root, 'target')
    const link = join(root, 'linked-output')
    mkdirSync(target)
    symlinkSync(target, link)
    expect(() => buildHandbook(repo, link, { minScreenshots: 0, minGroups: 0 })).toThrow('must not be a symlink')
  })

  it.each(['empty', 'previous handbook build'])(
    'replaces an %s output directory', (kind) => {
      const root = tempRoot()
      const repo = captureRepo(root)
      writeCaptureMetadata(repo)
      const output = join(root, 'output')
      mkdirSync(output)
      if (kind === 'previous handbook build') writePreviousBuild(output)
      const result = buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 })
      expect(result.outputDir).toBe(output)
      expect(existsSync(join(output, 'index.html'))).toBe(true)
    }
  )

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

  it('rejects stale screenshots when src/server.ts changes', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const group = join(repo, 'docs/handbook/screenshots/chapter')
    mkdirSync(group, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeCaptureMetadata(repo)
    writeFileSync(join(repo, 'src/server.ts'), 'changed after capture\n')
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
    for (const font of ['Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'Inter-Bold.woff2']) {
      writeFileSync(join(repo, 'src/assets/fonts', font), `font:${font}`)
    }
    writeFileSync(join(repo, 'src/assets/fonts/Inter-LICENSE.txt'), 'OFL license')
    writeCaptureMetadata(repo)
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

  it('keeps a successful replacement when removing the backup fails', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeCaptureMetadata(repo)
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n')
    writeFileSync(join(screenshots, '01-page.png'), png())
    writeFileSync(join(screenshots, '01-page.md'), '# Page\n')
    const output = join(root, 'output')
    writePreviousBuild(output)
    let removals = 0
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = buildHandbook(repo, output, {
        minScreenshots: 0,
        minGroups: 0,
        fs: {
          existsSync,
          mkdtempSync,
          renameSync,
          rmSync: (path, options) => {
            if (String(path).includes('.output-backup-') && ++removals === 2) throw new Error('backup cleanup failed')
            return rmSync(path, options)
          }
        }
      })
      expect(result.outputDir).toBe(output)
      expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('<h3>Page</h3>')
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('backup cleanup failed')
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('.output-backup-')
    } finally {
      stderr.mockRestore()
    }
  })

  it('preserves the old output when renaming the temporary output fails', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeCaptureMetadata(repo)
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n')
    writeFileSync(join(screenshots, '01-page.png'), png())
    writeFileSync(join(screenshots, '01-page.md'), '# Page\n')
    const output = join(root, 'output')
    writePreviousBuild(output)
    const resolvedOutput = realpathSync(output)
    expect(() => buildHandbook(repo, output, {
      minScreenshots: 0,
      minGroups: 0,
      fs: {
        existsSync,
        mkdtempSync,
        rmSync,
        renameSync: (source, destination) => {
          if (String(source).includes('.output-tmp-') && destination === resolvedOutput) throw new Error('replacement rename failed')
          return renameSync(source, destination)
        }
      }
    })).toThrow('replacement rename failed')
    expect(readFileSync(join(output, 'marker.txt'), 'utf8')).toBe('keep this output')
  })

  it('reports both output and backup paths when restoring the old output fails', () => {
    const root = tempRoot()
    const repo = join(root, 'repo')
    const screenshots = join(repo, 'docs/handbook/screenshots/chapter')
    mkdirSync(screenshots, { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs/handbook'), { recursive: true })
    writeFileSync(join(repo, 'src/html.ts'), 'export const current = true\n')
    writeFileSync(join(repo, 'docs/handbook/intro.md'), '# Introduction\n')
    writeCaptureMetadata(repo)
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n')
    writeFileSync(join(screenshots, '01-page.png'), png())
    writeFileSync(join(screenshots, '01-page.md'), '# Page\n')
    const output = join(root, 'output')
    mkdirSync(output)
    const originalRename = renameSync
    let backupPath = ''
    let errorMessage = ''
    try {
      buildHandbook(repo, output, {
        minScreenshots: 0,
        minGroups: 0,
        fs: {
          existsSync,
          mkdtempSync,
          rmSync,
          renameSync: (source, destination) => {
            if (String(destination).includes('.output-backup-')) backupPath = String(destination)
            if (String(source).includes('.output-tmp-') && String(destination) === realpathSync(output)) throw new Error('replacement rename failed')
            if (String(source) === backupPath && String(destination) === output) throw new Error('restore rename failed')
            return originalRename(source, destination)
          }
        }
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).toContain(`output path: ${output}; backup path: ${backupPath}`)
    expect(backupPath).toContain('.output-backup-')
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
    writeCaptureMetadata(repo)
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
    writeCaptureMetadata(repo)
    writeFileSync(join(screenshots, '_group.md'), '# Chapter\n')
    writeFileSync(join(screenshots, '01-invalid.png'), png().fill(0, 12, 16))
    writeFileSync(join(screenshots, '01-invalid.md'), '# Invalid screenshot\n')
    const output = join(root, 'output')
    writePreviousBuild(output)

    expect(() => buildHandbook(repo, output, { minScreenshots: 0, minGroups: 0 }))
      .toThrow('PNG has no IHDR header')
    expect(readFileSync(join(output, 'marker.txt'), 'utf8')).toBe('keep this output')
  })
})
