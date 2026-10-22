import type { Server } from 'node:http'

export type ShutdownDependencies = {
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>
  publisher: { stop(): Promise<void> }
  db: { close(): void }
  exit: (code: number) => void
  log: (line: string) => void
  graceMs?: number
}

export async function shutdown({
  server,
  publisher,
  db,
  exit,
  log,
  graceMs = 5000
}: ShutdownDependencies): Promise<void> {
  const closed = new Promise<Error | undefined>((resolve) => {
    try {
      server.close((error) => resolve(error))
    } catch (error) {
      resolve(error instanceof Error ? error : new Error('Server close failed'))
    }
  })
  try {
    server.closeIdleConnections()
  } catch {
    log('Server close failed')
  }

  try {
    await publisher.stop()
  } catch {
    log('Publisher stop failed')
  }
  try {
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<{ timedOut: true }>((resolve) => {
      graceTimer = setTimeout(() => resolve({ timedOut: true }), graceMs)
      graceTimer.unref()
    })
    let outcome: { timedOut: true } | { timedOut: false; error: Error | undefined }
    try {
      outcome = await Promise.race([
        closed.then((error) => ({ timedOut: false as const, error })),
        grace
      ])
    } finally {
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
    }
    if (outcome.timedOut) {
      // Let started requests receive their replies; runtime stop grace is at least 100 seconds.
      server.closeAllConnections()
    }
    const error = outcome.timedOut ? await closed : outcome.error
    if (error) {
      throw error
    }
  } catch {
    log('Server close failed')
  } finally {
    try {
      db.close()
    } catch {
      log('Database close failed')
    }
    exit(0)
  }
}
