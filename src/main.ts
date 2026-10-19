import { buildApp } from './app'
import { loadConfig } from './config'
import { openDatabase } from './db'
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
  publisher.start().catch(() => {
    log('Publisher failed to start')
    process.exit(1)
  })
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) {
    return
  }
  stopping = true
  try {
    await publisher.stop()
  } catch {
    log('Publisher stop failed')
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  } catch {
    log('Server close failed')
  } finally {
    try {
      db.close()
    } catch {
      log('Database close failed')
    }
    process.exit(0)
  }
}

process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
