/**
 * Guards the portability claim on every `.ts` file directly under `review/`.
 * The file list is `readdirSync` — a new file is picked up without updating
 * this test. Allowed imports: `node:` specifiers, `zod`, `vitest` (test files),
 * and relative imports that resolve inside `review/`. An import of lodash, or a
 * relative import that leaves this directory toward src/status, fails.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const reviewDir = fileURLToPath(new URL('.', import.meta.url))

function reviewTypeScriptFiles(): string[] {
  return readdirSync(reviewDir).filter((name) => name.endsWith('.ts'))
}

/** Quoted specifiers on static from-clauses and on side-effect imports. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const fromClause = /\bfrom\s+['"]([^'"]+)['"]/g
  const sideEffect = /^import\s+['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(fromClause)) {
    specifiers.push(match[1]!)
  }
  for (const match of source.matchAll(sideEffect)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

function isAllowed(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  if (specifier === 'zod') return true
  if (specifier === 'vitest') return true
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = resolve(reviewDir, specifier)
    const rel = relative(reviewDir, resolved)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
  return false
}

describe('review/ portability', () => {
  it('imports only node:, zod, vitest, or relative paths inside review/', () => {
    const files = reviewTypeScriptFiles()
    expect(files.length).toBeGreaterThan(0)

    const hits: string[] = []
    for (const name of files) {
      const source = readFileSync(join(reviewDir, name), 'utf-8')
      for (const specifier of importSpecifiers(source)) {
        if (!isAllowed(specifier)) {
          hits.push(`${name}: ${specifier}`)
        }
      }
    }

    expect(hits).toEqual([])
  })
})
