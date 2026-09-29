import { describe, expect, it } from 'vitest'
import {
  hashBootstrapPassword, hashPassword, isAcceptablePasswordLength, passwordNeedsRehash, verifyPassword,
} from './password.js'

describe('password', () => {
  it('Argon2idでhash/verifyし、平文を含めない', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(hash).not.toContain('correct horse')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(hash, 'wrong password')).toBe(false)
    expect(passwordNeedsRehash(hash)).toBe(false)
  })

  it('短すぎるpasswordと壊れたhashを安全に扱う', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/12-1024 bytes/)
    expect(await verifyPassword(await hashBootstrapPassword('temporary11'), 'temporary11')).toBe(true)
    expect(await verifyPassword('broken', 'anything')).toBe(false)
    expect(passwordNeedsRehash('broken')).toBe(true)
  })

  it('長さは文字数ではなく UTF-8 の byte で数える', () => {
    expect(isAcceptablePasswordLength('あ'.repeat(4))).toBe(true)      // 12 byte
    expect(isAcceptablePasswordLength('a'.repeat(11))).toBe(false)
    expect(isAcceptablePasswordLength('あ'.repeat(341))).toBe(true)    // 1023 byte
    expect(isAcceptablePasswordLength('あ'.repeat(342))).toBe(false)   // 1026 byte
  })
})
