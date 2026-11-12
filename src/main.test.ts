import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

describe('application process', () => {
  it('starts under Node ESM and serves healthz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-start-'))
    const reservation = createServer()
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let stderr = ''
    try {
      const pack = join(dir, 'content', 'start-test')
      mkdirSync(pack, { recursive: true })
      writeFileSync(join(pack, 'rules.json'), JSON.stringify({ topic: 'start-test', forbiddenClaims: [] }))
      reservation.listen(0, '127.0.0.1')
      await once(reservation, 'listening')
      const address = reservation.address()
      if (!address || typeof address === 'string') throw new Error('No port allocated')
      const port = address.port
      await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
      child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PORT: String(port), DB_PATH: join(dir, 'outbox.sqlite'), PACK_ROOT: dir,
          BRAND: 'start-test', JWT_SECRET: 'test-only-secret',
          DFX_API_BASE_URL: 'http://127.0.0.1:9', OUTBOX_PUBLIC_URL: `http://127.0.0.1:${port}`,
          X_CLIENT_ID: 'test-client', X_HANDLE: 'test_handle', X_API_BASE: 'http://127.0.0.1:9'
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      exited = once(child, 'exit')
      const deadline = Date.now() + 20_000
      let status = 0
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Outbox exited before startup: ${stderr}`)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
          status = response.status
          if (status === 200) break
        } catch { /* The process has not bound its port yet. */ }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(status, `Outbox did not serve healthz: ${stderr}`).toBe(200)
    } finally {
      if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()))
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 25_000)

  it('exits when the database is from an unreleased schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-legacy-db-'))
    const file = join(dir, 'outbox.sqlite')
    const legacy = new Database(file)
    legacy.exec(`CREATE TABLE audit (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      actorUser TEXT NOT NULL,
      actorAccount TEXT NOT NULL
    )`)
    legacy.prepare(
      `INSERT INTO audit (id, at, event, actorUser, actorAccount) VALUES ('legacy', 1, 'published', 'system', 'system')`
    ).run()
    legacy.close()
    let child: ReturnType<typeof spawn> | undefined
    let stdout = ''
    let stderr = ''
    try {
      child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          PORT: '3999',
          DB_PATH: file,
          BRAND: 'legacy-test',
          JWT_SECRET: 'test-only-secret',
          DFX_API_BASE_URL: 'http://127.0.0.1:9',
          OUTBOX_PUBLIC_URL: 'http://127.0.0.1:3999',
          X_CLIENT_ID: 'test-client',
          X_HANDLE: 'test_handle'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const closed = once(child, 'close')
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`still running\n${stdout}\n${stderr}`)), 15_000)
      })
      const [code] = await Promise.race([closed, timeout])
      expect(code, stderr).toBe(1)
      expect(stdout).toContain('This database was created by an unreleased version of Outbox (schema version 0). Start with a new database file.')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
