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
if (config.xRefreshToken) {
  seedCredentials(db, config.xRefreshToken)
}
const { server, publisher } = buildApp(config, { db })

server.listen(config.port, () => {
  void publisher.start()
})

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) {
    return
  }
  stopping = true
  await publisher.stop()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  db.close()
  process.exit(0)
}

process.once('SIGTERM', () => {
  void shutdown()
})
process.once('SIGINT', () => {
  void shutdown()
})
