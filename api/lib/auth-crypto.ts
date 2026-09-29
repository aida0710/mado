import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest()
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

// session token・SSO の browser binding・logout token などの opaque な値の長さの範囲。
// randomToken(32) は base64url で 43 文字。これを大きく外れる値は DB を引く前に捨てる。
const OPAQUE_TOKEN_MIN_LENGTH = 32
const OPAQUE_TOKEN_MAX_LENGTH = 256

export function isPlausibleOpaqueToken(value: string): boolean {
  return value.length >= OPAQUE_TOKEN_MIN_LENGTH && value.length <= OPAQUE_TOKEN_MAX_LENGTH
}

export function newId(): string {
  return randomUUID()
}

export function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}
