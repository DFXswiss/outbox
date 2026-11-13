export const IMAGE_LIMIT = 5 * 1024 * 1024

export function imageMime(bytes: Buffer | Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.byteLength >= 8 &&
    Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png'
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}
