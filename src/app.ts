import type { Server } from 'node:http'
import { createLogAlert } from './alerts'
import type { AppConfig } from './config'
import type { SqliteDatabase } from './db'
import { createHttpIntrospect } from './identity'
import { createLog } from './log'
import { createPublisher } from './publisher'
import { createOutboxServer } from './server'
import { createXClient } from './x-client'

export type AppDeps = {
  db: SqliteDatabase
  fetch?: typeof fetch
  now?: () => number
  log?: (line: string) => void
}

export type BuiltApp = {
  server: Server
  publisher: ReturnType<typeof createPublisher>
}

export function buildApp(config: AppConfig, deps: AppDeps): BuiltApp {
  const logger = createLog(
    deps.log ?? ((line) => process.stdout.write(line + '\n'))
  )
  const x = createXClient({
    db: deps.db,
    clientId: config.xClientId,
    ...(config.xClientSecret !== undefined
      ? { clientSecret: config.xClientSecret }
      : {}),
    handle: config.xHandle,
    apiBase: config.xApiBase,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {})
  })
  const publisher = createPublisher({
    db: deps.db,
    x,
    alert: createLogAlert(logger),
    log: logger,
    ...(deps.now ? { now: deps.now } : {})
  })
  const server = createOutboxServer({
    db: deps.db,
    packRoot: config.packRoot,
    brand: config.brand,
    jwtSecret: config.jwtSecret,
    introspect: createHttpIntrospect({
      baseUrl: config.dfxApiBaseUrl,
      jwtSecret: config.jwtSecret,
      ...(deps.fetch ? { fetch: deps.fetch } : {})
    }),
    probeX: () => publisher.probeState(),
    publisher,
    log: logger,
    ...(deps.now ? { now: deps.now } : {})
  })
  return { server, publisher }
}
