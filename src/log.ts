const BEARER = /Bearer\s+\S+/gi
const AUTHORIZATION = /(Authorization\s*[=:]\s*).+?(?=\s+Cookie\s*[=:]|$)/gi
const COOKIE = /(Cookie\s*[=:]\s*).+/gi
const SESSION_QUERY = /([?&]session=)[^&]*/gi

/**
 * Replaces Authorization, Cookie, Bearer tokens, and `session=` query
 * values so a JWT never lands in a log line.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER, 'Bearer ***')
    .replace(AUTHORIZATION, '$1***')
    .replace(COOKIE, '$1***')
    .replace(SESSION_QUERY, '$1***')
}

/** Default sink: one redacted line to stdout. Override via `write`. Redaction runs first. */
export function createLog(
  write: (line: string) => void = (line) => process.stdout.write(line + '\n')
) {
  return (line: string): void => {
    write(redactSecrets(line))
  }
}
