import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface CryptoModule {
  encrypt(plaintext: string): string   // "v1:iv_b64:tag_b64:ct_b64" 形式で返す
  decrypt(packed: string): string      // バージョン/タグ/暗号文が不正な場合は例外を投げる
  mask(plaintext: string): string      // 例: "AKIA…XYZ4"; 8文字以下は "*" を繰り返して返す
}

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

export function createCrypto(rawKey: string): CryptoModule {
  if (!HEX_KEY_RE.test(rawKey)) {
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex chars (32 bytes); got ${rawKey.length} chars`,
    )
  }
  const key = Buffer.from(rawKey, 'hex')
  if (key.length !== 32) {
    // 多重防御 — 上のregexでも検証済みだが念のため。
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex chars (32 bytes); got ${rawKey.length} chars`,
    )
  }

  function encrypt(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
  }

  function decrypt(packed: string): string {
    const parts = packed.split(':')
    if (parts.length !== 4) {
      throw new Error('crypto: malformed packed ciphertext')
    }
    const [v, ivB64, tagB64, ctB64] = parts
    if (v !== 'v1') {
      throw new Error('crypto: unsupported version: ' + v)
    }
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ct = Buffer.from(ctB64, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  }

  function mask(plaintext: string): string {
    if (plaintext.length <= 8) {
      return '*'.repeat(plaintext.length)
    }
    return plaintext.slice(0, 4) + '…' + plaintext.slice(-4)
  }

  return { encrypt, decrypt, mask }
}
