import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('reports missing required variable names without exposing values', () => {
    const result = loadConfig({
      X_CLIENT_SECRET: 'secret-value'
    } as NodeJS.ProcessEnv)
    expect(result).toEqual({
      ok: false,
      variables: expect.arrayContaining([
        'DB_PATH',
        'BRAND',
        'DFX_API_BASE_URL',
        'X_CLIENT_ID',
        'X_HANDLE'
      ])
    })
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('uses defaults and parses the required configuration', () => {
    const result = loadConfig({
      DB_PATH: '/tmp/outbox.sqlite',
      BRAND: 'test-brand',
      DFX_API_BASE_URL: 'https://identity.invalid',
      X_CLIENT_ID: 'test-client',
      X_HANDLE: '@test_handle'
    } as NodeJS.ProcessEnv)
    expect(result).toMatchObject({
      ok: true,
      config: {
        port: 3000,
        packRoot: '.',
        brand: 'test-brand',
        xApiBase: 'https://api.x.com'
      }
    })
  })
})
