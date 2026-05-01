import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCrypto } from './crypto.js'

const TEST_KEY = '0'.repeat(64)

describe('createCrypto', () => {
  it('throws on a key that is too short', () => {
    expect(() => createCrypto('abc')).toThrow(/64 hex chars/)
  })

  it('throws on 64 chars with non-hex characters', () => {
    expect(() => createCrypto('z'.repeat(64))).toThrow(/64 hex chars/)
  })

  it('throws on empty key', () => {
    expect(() => createCrypto('')).toThrow(/64 hex chars/)
  })

  it('accepts a valid 64-char hex key', () => {
    expect(() => createCrypto(TEST_KEY)).not.toThrow()
  })

  it('accepts a randomly generated 32-byte hex key', () => {
    const key = randomBytes(32).toString('hex')
    expect(() => createCrypto(key)).not.toThrow()
  })
})

describe('encrypt + decrypt round-trip', () => {
  const crypto = createCrypto(TEST_KEY)

  it('round-trips simple ASCII', () => {
    const pt = 'hello world'
    const packed = crypto.encrypt(pt)
    expect(packed.startsWith('v1:')).toBe(true)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('round-trips empty string', () => {
    const pt = ''
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('round-trips multi-byte UTF-8 characters', () => {
    const pt = '日本語テスト 🎉 emoji αβγ'
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('round-trips a long string', () => {
    const pt = 'x'.repeat(10_000)
    const packed = crypto.encrypt(pt)
    expect(crypto.decrypt(packed)).toBe(pt)
  })

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const pt = 'same input'
    const a = crypto.encrypt(pt)
    const b = crypto.encrypt(pt)
    expect(a).not.toBe(b)
    expect(crypto.decrypt(a)).toBe(pt)
    expect(crypto.decrypt(b)).toBe(pt)
  })

  it('round-trips with a key created from randomBytes', () => {
    const key = randomBytes(32).toString('hex')
    const c = createCrypto(key)
    const pt = 'AKIAEXAMPLE12345'
    expect(c.decrypt(c.encrypt(pt))).toBe(pt)
  })
})

describe('decrypt failure modes', () => {
  const crypto = createCrypto(TEST_KEY)

  it('throws on tampered ciphertext (mutated byte)', () => {
    const packed = crypto.encrypt('hello world')
    const [v, iv, tag, ct] = packed.split(':')
    const ctBuf = Buffer.from(ct, 'base64')
    // 最初のバイトの1ビットを反転する
    ctBuf[0] = ctBuf[0] ^ 0x01
    const tampered = `${v}:${iv}:${tag}:${ctBuf.toString('base64')}`
    expect(() => crypto.decrypt(tampered)).toThrow()
  })

  it('throws on tampered tag', () => {
    const packed = crypto.encrypt('hello world')
    const [v, iv, tag, ct] = packed.split(':')
    const tagBuf = Buffer.from(tag, 'base64')
    tagBuf[0] = tagBuf[0] ^ 0x01
    const tampered = `${v}:${iv}:${tagBuf.toString('base64')}:${ct}`
    expect(() => crypto.decrypt(tampered)).toThrow()
  })

  it('throws on unsupported version', () => {
    const packed = crypto.encrypt('hello world')
    const parts = packed.split(':')
    parts[0] = 'v9'
    const bad = parts.join(':')
    expect(() => crypto.decrypt(bad)).toThrow(/unsupported version: v9/)
  })

  it('throws when decrypting with a different key', () => {
    const a = createCrypto(TEST_KEY)
    const b = createCrypto('1'.repeat(64))
    const packed = a.encrypt('secret')
    expect(() => b.decrypt(packed)).toThrow()
  })
})

describe('mask', () => {
  const crypto = createCrypto(TEST_KEY)

  it('masks empty string as empty', () => {
    expect(crypto.mask('')).toBe('')
  })

  it('masks 2-char string with stars', () => {
    expect(crypto.mask('AB')).toBe('**')
  })

  it('masks 8-char string entirely with stars (boundary)', () => {
    expect(crypto.mask('ABCDEFGH')).toBe('********')
  })

  it('masks 9+ char string with first 4 + ellipsis + last 4', () => {
    expect(crypto.mask('AKIAEXAMPLE12345')).toBe('AKIA…2345')
  })
})
