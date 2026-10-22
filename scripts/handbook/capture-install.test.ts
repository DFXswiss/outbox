import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installCapture } from './capture-install.mjs'

const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'outbox-capture-install-test-'))
  roots.push(root)
  const stageRoot = join(root, 'stage')
  const stagedRoot = join(root, 'staged')
  const outputRoot = join(root, 'output')
  fs.mkdirSync(stageRoot)
  fs.mkdirSync(stagedRoot)
  fs.mkdirSync(outputRoot)
  writeFileSync(join(outputRoot, 'one.png'), 'old one')
  writeFileSync(join(outputRoot, 'two.png'), 'old two')
  writeFileSync(join(outputRoot, 'capture.json'), 'old metadata')
  writeFileSync(join(stagedRoot, 'one.png'), 'new one')
  writeFileSync(join(stagedRoot, 'two.png'), 'new two')
  writeFileSync(join(stagedRoot, 'capture.json'), 'new metadata')
  return {
    root,
    stageRoot,
    stagedRoot,
    outputRoot,
    options: {
      stageRoot,
      previousFiles: ['one.png', 'two.png', 'capture.json'].map((relativePath) => ({ source: join(outputRoot, relativePath), relativePath })),
      stagedFiles: ['one.png', 'two.png'].map((name) => ({ source: join(stagedRoot, name), destination: join(outputRoot, name) })),
      metadataSource: join(stagedRoot, 'capture.json'),
      metadataDestination: join(outputRoot, 'capture.json')
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('capture installation', () => {
  it('replaces the previous capture files and metadata', () => {
    const { options, outputRoot, stagedRoot } = fixture()
    installCapture(options)
    expect(readFileSync(join(outputRoot, 'one.png'), 'utf8')).toBe('new one')
    expect(readFileSync(join(outputRoot, 'two.png'), 'utf8')).toBe('new two')
    expect(readFileSync(join(outputRoot, 'capture.json'), 'utf8')).toBe('new metadata')
  })

  it('restores all previous files after an install failure', () => {
    const { options, outputRoot, stagedRoot } = fixture()
    const originalRename = fs.renameSync
    let failed = false
    expect(() => installCapture({
      ...options,
      fileSystem: {
        ...fs,
        renameSync: (source, destination) => {
          if (!failed && String(source) === join(stagedRoot, 'two.png')) {
            failed = true
            throw new Error('install rename failed')
          }
          return originalRename(source, destination)
        }
      }
    })).toThrow('install rename failed')
    expect(readFileSync(join(outputRoot, 'one.png'), 'utf8')).toBe('old one')
    expect(readFileSync(join(outputRoot, 'two.png'), 'utf8')).toBe('old two')
    expect(readFileSync(join(outputRoot, 'capture.json'), 'utf8')).toBe('old metadata')
  })

  it('continues restoring after a restore failure and retains the backup path', () => {
    const { options, outputRoot, stageRoot, stagedRoot } = fixture()
    const originalRename = fs.renameSync
    let installFailed = false
    let restoreFailed = false
    let caught: unknown
    try {
      installCapture({
        ...options,
        fileSystem: {
          ...fs,
          renameSync: (source, destination) => {
            const sourcePath = String(source)
            if (!installFailed && sourcePath === join(stagedRoot, 'two.png')) {
              installFailed = true
              throw new Error('install rename failed')
            }
            if (!restoreFailed && sourcePath === join(stageRoot, 'backup', 'two.png')) {
              restoreFailed = true
              throw new Error('restore rename failed')
            }
            return originalRename(source, destination)
          }
        }
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('restore rename failed')
    expect((caught as Error).message).toContain(join(stageRoot, 'backup'))
    expect((caught as Error & { preserveStageRoot?: string }).preserveStageRoot).toBe(stageRoot)
    expect(readFileSync(join(outputRoot, 'one.png'), 'utf8')).toBe('old one')
    expect(readFileSync(join(outputRoot, 'capture.json'), 'utf8')).toBe('old metadata')
    expect(readFileSync(join(stageRoot, 'backup', 'two.png'), 'utf8')).toBe('old two')
  })
})
