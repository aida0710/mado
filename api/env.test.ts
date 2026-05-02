import { describe, expect, it } from 'vitest'
import { loadEnv } from './env.js'

const VALID_KEY = '0'.repeat(64)

describe('loadEnv', () => {
  it('parses required env vars', () => {
    const env = loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
      ENCRYPTION_KEY: VALID_KEY,
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })
    expect(env.PORT).toBe(3000)
    expect(env.WRITE_TOKEN).toBe(VALID_KEY)
    expect(env.ENCRYPTION_KEY).toBe(VALID_KEY)
    expect(env.ALLOWED_ORIGINS).toEqual(['http://localhost:5173'])
    expect(env.PREVIEW_TEXT_LIMIT).toBe(65536) // デフォルト値
    expect(env.PREVIEW_TAR_ENTRY_LIMIT).toBe(200)
  })

  it('splits ALLOWED_ORIGINS by comma + trims spaces + drops empty', () => {
    const env = loadEnv({
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
      ENCRYPTION_KEY: VALID_KEY,
      ALLOWED_ORIGINS: 'http://localhost:5173, http://lab-server ,',
    })
    expect(env.ALLOWED_ORIGINS).toEqual([
      'http://localhost:5173',
      'http://lab-server',
    ])
  })

  it('throws on missing ALLOWED_ORIGINS', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
      ENCRYPTION_KEY: VALID_KEY,
    })).toThrow(/ALLOWED_ORIGINS/)
  })

  it('throws on missing required var', () => {
    expect(() => loadEnv({ PORT: '3000' })).toThrow(/DATABASE_URL_RW/)
  })

  it('throws on WRITE_TOKEN with wrong format', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: 'too-short',
      ENCRYPTION_KEY: VALID_KEY,
    })).toThrow(/WRITE_TOKEN/)
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: 'z'.repeat(64),  // right length, non-hex
      ENCRYPTION_KEY: VALID_KEY,
    })).toThrow(/WRITE_TOKEN/)
  })

  it('throws on missing ENCRYPTION_KEY', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
    })).toThrow(/ENCRYPTION_KEY/)
  })

  it('throws on ENCRYPTION_KEY with wrong length', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
      ENCRYPTION_KEY: 'abc',
    })).toThrow(/ENCRYPTION_KEY/)
  })

  it('throws on ENCRYPTION_KEY with non-hex chars', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: VALID_KEY,
      ENCRYPTION_KEY: 'z'.repeat(64),
    })).toThrow(/ENCRYPTION_KEY/)
  })
})
