import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it.each(['0', '-1', '1.5'])('rejects an invalid weighted length %s', (limit) => {
    const result = loadConfig({ DB_PATH: '/tmp/outbox.sqlite', BRAND: 'test', DFX_API_BASE_URL: 'https://identity.invalid', OUTBOX_PUBLIC_URL: 'https://outbox.invalid', X_CLIENT_ID: 'client', X_HANDLE: 'handle', X_MAX_WEIGHTED_LENGTH: limit })
    expect(result).toMatchObject({ ok: false, variables: expect.arrayContaining(['X_MAX_WEIGHTED_LENGTH']) })
  })

  it('requires a public URL without a trailing slash', () => {
    const result = loadConfig({ DB_PATH: '/tmp/outbox.sqlite', BRAND: 'test', DFX_API_BASE_URL: 'https://identity.invalid', OUTBOX_PUBLIC_URL: 'https://outbox.invalid/', X_CLIENT_ID: 'client', X_HANDLE: 'handle' })
    expect(result).toMatchObject({ ok: false, variables: expect.arrayContaining(['OUTBOX_PUBLIC_URL']) })
  })
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
        'OUTBOX_PUBLIC_URL',
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
      OUTBOX_PUBLIC_URL: 'https://outbox.invalid',
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

  it('maps each environment variable to its matching config field', () => {
    const result = loadConfig({
      PORT: '4321',
      DB_PATH: '/tmp/sentinel-db.sqlite',
      PACK_ROOT: '/tmp/sentinel-packs',
      BRAND: 'gifts',
      DFX_API_BASE_URL: 'https://identity.sentinel.invalid',
      OUTBOX_PUBLIC_URL: 'https://outbox.sentinel.invalid',
      JWT_SECRET: 'jwt-sentinel',
      X_CLIENT_ID: 'client-id-sentinel',
      X_CLIENT_SECRET: 'client-secret-sentinel',
      X_REFRESH_TOKEN: 'refresh-sentinel',
      X_HANDLE: '@handle-sentinel',
      X_API_BASE: 'https://x-api.sentinel.invalid'
    } as NodeJS.ProcessEnv)

    expect(result).toEqual({
      ok: true,
      config: {
        port: 4321,
        dbPath: '/tmp/sentinel-db.sqlite',
        packRoot: '/tmp/sentinel-packs',
        brand: 'gifts',
        dfxApiBaseUrl: 'https://identity.sentinel.invalid',
        outboxPublicUrl: 'https://outbox.sentinel.invalid',
        jwtSecret: 'jwt-sentinel',
        xClientId: 'client-id-sentinel',
        xClientSecret: 'client-secret-sentinel',
        xRefreshToken: 'refresh-sentinel',
        xHandle: '@handle-sentinel',
        xMaxWeightedLength: 25000,
        xApiBase: 'https://x-api.sentinel.invalid'
      }
    })
  })
})
