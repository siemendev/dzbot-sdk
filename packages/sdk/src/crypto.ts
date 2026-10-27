const encoder = new TextEncoder()

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) throw new Error('@dzbot/sdk needs WebCrypto (any browser, Node 20+, Deno, Bun, Workers)')
  return crypto.subtle
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const b of view) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  return subtle().digest('SHA-256', data as BufferSource)
}

export async function hmacSha256Hex(secret: string, data: Uint8Array): Promise<string> {
  const key = await subtle().importKey('raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await subtle().sign('HMAC', key, data as BufferSource))
}

/** Compares in time independent of where the strings differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** RFC 7636: the S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(utf8(verifier)))
}

export function pkceVerifier(): string {
  return base64url(randomBytes(32))
}
