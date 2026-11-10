import { createServer, request, type Server } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createXProxy } from './x-proxy'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)) })
}
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }

describe('X transport proxy', () => {
  it('forwards an unmarked compressed response byte-for-byte', async () => {
    const compressed = gzipSync(Buffer.from('{"data":{"id":"123","text":"ordinary"}}'))
    const upstream = createServer((_req, res) => {
      // Shape: https://docs.x.com/x-api/posts/create-post
      res.writeHead(201, { 'content-encoding': 'gzip', 'content-length': compressed.length })
      res.end(compressed)
    })
    const port = await listen(upstream)
    const proxy = createXProxy({ upstream: `http://127.0.0.1:${port}`, markedText: 'marker' })
    const proxyPort = await listen(proxy.server)
    try {
      const result = await new Promise<{ body: Buffer; encoding: string | undefined }>((resolve, reject) => {
        const client = request(`http://127.0.0.1:${proxyPort}/2/tweets`, { method: 'POST' }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => resolve({ body: Buffer.concat(chunks), encoding: response.headers['content-encoding'] }))
          response.on('error', reject)
        })
        client.on('error', reject)
        client.end('{"text":"ordinary"}')
      })
      expect(result.encoding).toBe('gzip')
      expect(result.body).toEqual(compressed)
      expect(proxy.droppedTweetIds).toEqual([])
    } finally { await close(proxy.server); await close(upstream) }
  })

  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync]
  ] as const)('captures the ID from a %s response and drops the connection', async (encoding, compress) => {
    let calls = 0
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).toString()).toBe('{"text":"marker"}')
      calls += 1
      // Shape: https://docs.x.com/x-api/posts/create-post
      const body = compress(Buffer.from('{"data":{"id":"2120178475663233374","text":"marker"}}'))
      res.writeHead(201, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': body.length })
      res.end(body)
    })
    const port = await listen(upstream)
    const proxy = createXProxy({ upstream: `http://127.0.0.1:${port}`, markedText: 'marker' })
    const proxyPort = await listen(proxy.server)
    try {
      await expect(fetch(`http://127.0.0.1:${proxyPort}/2/tweets`, { method: 'POST', body: '{"text":"marker"}' })).rejects.toThrow()
      expect(calls).toBe(1)
      expect(proxy.droppedTweetIds).toEqual(['2120178475663233374'])
    } finally { await close(proxy.server); await close(upstream) }
  })

  it('passes ordinary traffic and drops the marked real response after upstream receives it', async () => {
    const received: string[] = []
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push(Buffer.concat(chunks).toString())
      res.writeHead(201, { 'content-type': 'application/json', 'x-test': 'same' })
      res.end('{"data":{"id":"123","text":"marker"}}')
    })
    const port = await listen(upstream)
    const proxy = createXProxy({ upstream: `http://127.0.0.1:${port}`, markedText: 'marker' })
    const proxyPort = await listen(proxy.server)
    try {
      const normal = await fetch(`http://127.0.0.1:${proxyPort}/2/tweets`, { method: 'POST', body: '{"text":"ordinary"}' })
      expect(normal.status).toBe(201)
      expect(normal.headers.get('x-test')).toBe('same')
      expect(await normal.text()).toBe('{"data":{"id":"123","text":"marker"}}')
      await expect(fetch(`http://127.0.0.1:${proxyPort}/2/tweets`, { method: 'POST', body: '{"text":"marker"}' })).rejects.toThrow()
      expect(received).toEqual(['{"text":"ordinary"}', '{"text":"marker"}'])
      expect(proxy.droppedTweetIds).toEqual(['123'])
    } finally { await close(proxy.server); await close(upstream) }
  })
})
