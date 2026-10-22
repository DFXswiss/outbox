import { buildApp } from './app'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { shutdown as stopService } from './shutdown'
import { seedCredentials } from './x-client'

const loaded = loadConfig(process.env)
if (!loaded.ok) {
  process.stderr.write(`Invalid configuration: ${loaded.variables.join(', ')}\n`)
  process.exit(1)
}

const config = loaded.config
const db = openDatabase(config.dbPath)
const log = (line: string) => process.stdout.write(`${line}\n`)
if (config.xRefreshToken) {
  seedCredentials(db, config.xRefreshToken)
}
const { server, publisher } = buildApp(config, { db, log })

server.listen(config.port, () => {
  publisher.start().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'unknown error'
    log(`Publisher failed to start: ${detail}`)
    process.exit(1)
  })
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) {
    return
  }
  stopping = true
  await stopService({
    server,
    publisher,
    db,
    exit: (code) => process.exit(code),
    log
  })
}

process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
