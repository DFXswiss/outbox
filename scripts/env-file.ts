import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) result[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  return result
}

export function saveRefreshToken(path: string, token: string): void {
  if ((statSync(path).mode & 0o777) !== 0o600 || !token || /[\r\n]/.test(token)) throw new Error('Cannot safely store X refresh token')
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(?:export\s+)?X_REFRESH_TOKEN\s*=/.test(line))
  while (lines.at(-1) === '') lines.pop()
  lines.push(`X_REFRESH_TOKEN=${token}`)
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${lines.join('\n')}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
