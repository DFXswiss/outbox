import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('wallet personal_sign', () => {
  it('hex-encodes the UTF-8 message before personal_sign', async () => {
    const address = '0x1433a4c9eFA0525299B05a6d9f31016Da254c2f2'
    const text = 'ä [loc]_By_signing'
    const expected = `0x${Buffer.from(text, 'utf8').toString('hex')}`
    expect(expected.startsWith('0xc3a4')).toBe(true)
    expect(expected).not.toContain(text)

    const requests: Array<{ method: string; params?: unknown }> = []
    let click: (() => Promise<void>) | undefined
    const button = {
      disabled: false,
      addEventListener(type: string, handler: () => Promise<void>) {
        if (type === 'click') click = handler
      }
    }
    const status = { textContent: '' }
    const document = {
      querySelector(selector: string) {
        if (selector === '#wallet-login') return button
        if (selector === '#wallet-message') return status
        return null
      }
    }
    let href = ''
    const location = {
      get href() { return href },
      set href(value: string) { href = value }
    }
    const window = {
      ethereum: {
        request: async (args: { method: string; params?: unknown }) => {
          requests.push(args)
          if (args.method === 'eth_requestAccounts') return [address]
          if (args.method === 'personal_sign') return '0xsig'
          throw new Error(args.method)
        }
      }
    }
    const fetchImpl = async (input: string) => {
      if (String(input).startsWith('/auth/wallet/message')) return { ok: true, json: async () => ({ message: text }) }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const encodeUtf8 = (value: string) => [...new TextEncoder().encode(value)]
    const context = createContext({ document, window, fetch: fetchImpl, location, encodeUtf8 })
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'login.js'), 'utf8')
    runInContext(`function TextEncoder() {}\nTextEncoder.prototype.encode = function (value) { return encodeUtf8(value) }\n${source}`, context)
    expect(click).toBeTypeOf('function')
    await click!()
    expect(requests.find((item) => item.method === 'personal_sign')?.params).toEqual([expected, address])
    expect(href).toBe('/')
  })
})
