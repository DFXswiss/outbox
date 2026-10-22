// JavaScript lets the container run this health probe with bare node, without loading tsx.
const port = process.env.PORT || '3000'
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 4_000)

try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })
  if (response.status !== 200) process.exitCode = 1
  else {
    const body = await response.json()
    if (body?.queueRunning !== true) process.exitCode = 1
  }
} catch {
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
}
