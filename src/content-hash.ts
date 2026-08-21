import { createHash } from 'node:crypto'

/**
 * NUL between the three fields so no concatenation of text, time, and image
 * bytes can be rearranged into the same hash. Written as an escape: a literal
 * NUL in the source makes git treat the file as binary.
 */
const FIELD_SEPARATOR = '\u0000'

function hasBytes(imageBytes: Buffer | Uint8Array | null | undefined): imageBytes is Buffer | Uint8Array {
  return imageBytes != null && imageBytes.byteLength > 0
}

/**
 * SHA-256(text NUL scheduledAt NUL imageBytes). `scheduledAt` is epoch ms.
 * Without an image the third field is empty, not omitted — the trailing NUL
 * still belongs to the digest.
 */
export function contentHash(
  text: string,
  scheduledAt: number,
  imageBytes?: Buffer | Uint8Array | null
): string {
  const hash = createHash('sha256')
  hash.update(text, 'utf8')
  hash.update(FIELD_SEPARATOR)
  hash.update(String(scheduledAt))
  hash.update(FIELD_SEPARATOR)
  if (hasBytes(imageBytes)) hash.update(imageBytes)
  return hash.digest('hex')
}

export function imageSha256(imageBytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(imageBytes).digest('hex')
}
