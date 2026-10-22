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
      publisher: {
        async stop() {
          events.push('publisher.stop')
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
      'server.closeAllConnections',
      'db.close',
      'exit:0'
    ])
  })

  it('lets an active request finish during publisher stop and rejects a new connection', async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    let finishRequest!: () => void
    const finish = new Promise<void>((resolve) => {
      finishRequest = resolve
    })
    let publisherStopping!: () => void
    const stopping = new Promise<void>((resolve) => {
      publisherStopping = resolve
    })
    let finishPublisherStop!: () => void
    const finishPublisher = new Promise<void>((resolve) => {
      finishPublisherStop = resolve
    })

    const server = createServer(async (_request, response) => {
      requestStarted()
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('started:')
      await finish
      response.end('complete')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const root = `http://127.0.0.1:${address.port}`

    try {
      const activeRequest = fetch(`${root}/active`)
      await started
      const shutdownTask = shutdown({
        server,
        publisher: {
          async stop() {
            publisherStopping()
            await finishPublisher
          }
        },
        db: { close() {} },
        exit() {},
        log() {}
      })
      await stopping

      await expect(fetch(`${root}/new`)).rejects.toThrow()
      finishRequest()
      const response = await activeRequest
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('started:complete')

      finishPublisherStop()
      await shutdownTask
    } finally {
      finishRequest()
      finishPublisherStop()
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })
})
