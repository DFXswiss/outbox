import type { Server } from 'node:http'

export type ShutdownDependencies = {
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>
  publisher: { stop(): Promise<void> }
  db: { close(): void }
  exit: (code: number) => void
  log: (line: string) => void
}

export async function shutdown({
  server,
  publisher,
  db,
  exit,
  log
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
    server.closeAllConnections()
    const error = await closed
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
