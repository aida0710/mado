import { describe, expect, it } from 'vitest'
import { hashBootstrapPassword, hashPassword, passwordNeedsRehash, verifyPassword } from './password.js'

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
    await expect(hashPassword('short')).rejects.toThrow(/at least/)
    expect(await verifyPassword(await hashBootstrapPassword('temporary11'), 'temporary11')).toBe(true)
    expect(await verifyPassword('broken', 'anything')).toBe(false)
    expect(passwordNeedsRehash('broken')).toBe(true)
  })
})
