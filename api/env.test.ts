import { describe, expect, it } from 'vitest'
import { loadEnv } from './env.js'

describe('loadEnv', () => {
  it('parses required env vars', () => {
    const env = loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: 'long-token',
      S3_ENDPOINT: 'https://s3.example',
      S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    })
    expect(env.PORT).toBe(3000)
    expect(env.WRITE_TOKEN).toBe('long-token')
    expect(env.PREVIEW_TEXT_LIMIT).toBe(65536) // default
    expect(env.PREVIEW_TAR_ENTRY_LIMIT).toBe(200)
    expect(env.S3_REGION).toBe('auto')
  })

  it('throws on missing required var', () => {
    expect(() => loadEnv({ PORT: '3000' })).toThrow(/DATABASE_URL_RW/)
  })

  it('throws on too-short WRITE_TOKEN', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      WRITE_TOKEN: 'a',
      S3_ENDPOINT: 'https://s3.example',
      S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    })).toThrow(/WRITE_TOKEN/)
  })
})
