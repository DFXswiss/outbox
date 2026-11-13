import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

function decodeResponse(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case undefined:
    case '':
    case 'identity': return body
    case 'gzip': return gunzipSync(body)
    case 'deflate': return inflateSync(body)
    case 'br': return brotliDecompressSync(body)
    default: throw new Error('Unsupported X response encoding')
  }
}

export function createXProxy(options: { upstream: string; markedText: string }): { server: Server; droppedTweetIds: string[] } {
  const upstream = new URL(options.upstream)
  const droppedTweetIds: string[] = []
  let dropped = false
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const path = incoming.url ?? '/'
      let marked = false
      if (!dropped && incoming.method === 'POST' && path.split('?')[0] === '/2/tweets') {
        try { marked = JSON.parse(body.toString('utf8')).text === options.markedText } catch { /* pass through */ }
      }
      const headers = { ...incoming.headers, host: upstream.host }
      const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(path, upstream), { method: incoming.method, headers }, (response) => {
        if (marked && response.statusCode === 201) {
          const responseChunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => responseChunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            try {
              const decoded = decodeResponse(Buffer.concat(responseChunks), response.headers['content-encoding'])
              const id = JSON.parse(decoded.toString('utf8')).data.id
              if (typeof id === 'string' && /^\d+$/.test(id)) droppedTweetIds.push(id)
            } catch { /* missing id is reported by the harness */ }
            dropped = true
            outgoing.destroy()
          })
          response.on('error', () => outgoing.destroy())
        } else {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(outgoing)
        }
      })
      request.on('error', () => outgoing.destroy())
      request.end(body)
    } catch { outgoing.destroy() }
  })
  return { server, droppedTweetIds }
}
