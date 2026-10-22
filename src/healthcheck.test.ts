import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

const servers: Server[] = []
const children: ReturnType<typeof spawn>[] = []

async function runHealthcheck(status: number, body: string): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Stub server did not bind to a TCP port')
  const child = spawn(process.execPath, ['src/healthcheck.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(address.port) },
    stdio: 'ignore'
  })
  children.push(child)
  const [code] = await once(child, 'exit')
  return code ?? 1
}

async function runWithoutServer(): Promise<number> {
  const server = createServer()
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Stub server did not bind to a TCP port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const child = spawn(process.execPath, ['src/healthcheck.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(address.port) },
    stdio: 'ignore'
  })
  children.push(child)
  const [code] = await once(child, 'exit')
  return code ?? 1
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('container healthcheck', () => {
  it('exits successfully when the queue is running', async () => {
    expect(await runHealthcheck(200, JSON.stringify({ queueRunning: true }))).toBe(0)
  })

  it.each([
    ['queue stopped', 200, JSON.stringify({ queueRunning: false })],
    ['queue state missing', 200, JSON.stringify({})],
    ['queue state is a string', 200, JSON.stringify({ queueRunning: 'true' })],
    ['invalid JSON', 200, '{'],
    ['HTTP 500', 500, JSON.stringify({ queueRunning: true })]
  ] as const)('fails when %s', async (_name, status, body) => {
    expect(await runHealthcheck(status, body)).toBe(1)
  })

  it('fails when no service listens on the configured port', async () => {
    expect(await runWithoutServer()).toBe(1)
  })
})
