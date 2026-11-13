import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DB_PATH: z.string().min(1),
  // This directory contains content/<brand>/rules.json.
  PACK_ROOT: z.string().min(1).default('.'),
  BRAND: z.string().min(1),
  DFX_API_BASE_URL: z.string().url(),
  OUTBOX_PUBLIC_URL: z.string().url().refine((value) => !value.endsWith('/')),
  JWT_SECRET: z.string().optional(),
  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().optional(),
  X_REFRESH_TOKEN: z.string().optional(),
  X_HANDLE: z.string().min(1),
  X_MAX_WEIGHTED_LENGTH: z.coerce.number().int().positive().default(25_000),
  X_API_BASE: z.string().url().default('https://api.x.com')
})

export type AppConfig = {
  port: number
  dbPath: string
  packRoot: string
  brand: string
  dfxApiBaseUrl: string
  outboxPublicUrl: string
  jwtSecret?: string
  xClientId: string
  xClientSecret?: string
  xRefreshToken?: string
  xHandle: string
  xMaxWeightedLength: number
  xApiBase: string
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; variables: string[] }

export function loadConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const variables = [...new Set(
      parsed.error.issues.map((issue) => String(issue.path[0] ?? 'configuration'))
    )]
    return { ok: false, variables }
  }
  const value = parsed.data
  return {
    ok: true,
    config: {
      port: value.PORT,
      dbPath: value.DB_PATH,
      packRoot: value.PACK_ROOT,
      brand: value.BRAND,
      dfxApiBaseUrl: value.DFX_API_BASE_URL,
      outboxPublicUrl: value.OUTBOX_PUBLIC_URL,
      ...(value.JWT_SECRET !== undefined
        ? { jwtSecret: value.JWT_SECRET }
        : {}),
      xClientId: value.X_CLIENT_ID,
      ...(value.X_CLIENT_SECRET !== undefined
        ? { xClientSecret: value.X_CLIENT_SECRET }
        : {}),
      ...(value.X_REFRESH_TOKEN !== undefined
        ? { xRefreshToken: value.X_REFRESH_TOKEN }
        : {}),
      xHandle: value.X_HANDLE,
      xMaxWeightedLength: value.X_MAX_WEIGHTED_LENGTH,
      xApiBase: value.X_API_BASE
    }
  }
}
