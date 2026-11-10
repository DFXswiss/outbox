import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
