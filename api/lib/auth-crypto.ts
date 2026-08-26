import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest()
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function newId(): string {
  return randomUUID()
}

export function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}
