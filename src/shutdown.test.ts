import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { shutdown } from './shutdown'

describe('service shutdown', () => {
  it('stops accepting connections before stopping the publisher and closes resources in order', async () => {
    const events: string[] = []
    let completeClose: ((error?: Error) => void) | undefined
    const server = {
      close(callback: (error?: Error) => void) {
        events.push('server.close')
        completeClose = () => {
          events.push('server.closed')
          callback()
        }
      },
      closeIdleConnections() {
        events.push('server.closeIdleConnections')
      },
      closeAllConnections() {
        events.push('server.closeAllConnections')
        completeClose?.()
      }
    } as unknown as Server

    await shutdown({
      server,
      publisher: {
        async stop() {
          events.push('publisher.stop')
          completeClose?.()
        }
      },
      db: {
        close() {
          events.push('db.close')
        }
      },
      exit(code) {
        events.push(`exit:${code}`)
      },
      log(line) {
        events.push(`log:${line}`)
      }
    })

    expect(events).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'publisher.stop',
      'server.closed',
      'db.close',
      'exit:0'
    ])
  })

  it('lets an active request finish after publisher stop and rejects a new connection', async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    let requestEnded = false
    let closeAllCalls = 0

    const server = createServer(async (_request, response) => {
      requestStarted()
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('started:')
      await new Promise((resolve) => setTimeout(resolve, 50))
      requestEnded = true
      response.end('complete')
    })
    const closeAll = server.closeAllConnections.bind(server)
    server.closeAllConnections = () => {
      closeAllCalls += 1
      closeAll()
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const root = `http://127.0.0.1:${address.port}`

    try {
      const activeRequest = fetch(`${root}/active`)
      await started
      const shutdownTask = shutdown({
        server,
        publisher: { async stop() {} },
        db: { close() {} },
        exit() {},
        log() {}
      })
      await expect(fetch(`${root}/new`)).rejects.toThrow()
      const response = await activeRequest
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('started:complete')
      expect(requestEnded).toBe(true)
      expect(closeAllCalls).toBe(0)

      await shutdownTask
    } finally {
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })

  it('force closes a request that outlives the grace period', async () => {
    const events: string[] = []
    let completeClose: ((error?: Error) => void) | undefined
    const server = {
      close(callback: (error?: Error) => void) {
        events.push('server.close')
        completeClose = callback
      },
      closeIdleConnections() {
        events.push('server.closeIdleConnections')
      },
      closeAllConnections() {
        events.push('server.closeAllConnections')
        completeClose?.()
      }
    } as unknown as Server

    await shutdown({
      server,
      publisher: { async stop() { events.push('publisher.stop') } },
      db: { close() { events.push('db.close') } },
      exit(code) { events.push(`exit:${code}`) },
      log(line) { events.push(`log:${line}`) },
      graceMs: 100
    })

    expect(events).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'publisher.stop',
      'server.closeAllConnections',
      'db.close',
      'exit:0'
    ])
  })
})
