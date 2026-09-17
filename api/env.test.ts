import { describe, expect, it } from 'vitest'
import { loadEnv, loadLineageEnv } from './env.js'

const VALID_KEY = '0'.repeat(64)

describe('loadEnv', () => {
  it('必須の環境変数を読める', () => {
    const env = loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: VALID_KEY,
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })
    expect(env.PORT).toBe(3000)
    expect(env.MADO_ENV).toBe('development')
    expect(env.ENCRYPTION_KEY).toBe(VALID_KEY)
    expect(env.ALLOWED_ORIGINS).toEqual(['http://localhost:5173'])
    expect(env.PREVIEW_TEXT_LIMIT).toBe(65536) // デフォルト値
    expect(env.PREVIEW_TAR_ENTRY_LIMIT).toBe(200)
    expect(env.PREVIEW_TAR_ENTRY_MAX_BYTES).toBe(100 * 1024 * 1024)
    expect(env.AUTH_MODE).toBe('disabled')
    expect(env.AUTH_COOKIE_SECURE).toBe(false)
  })

  it('ALLOWED_ORIGINS はカンマで分け、空白を除き、空要素を落とす', () => {
    const env = loadEnv({
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: VALID_KEY,
      ALLOWED_ORIGINS: 'http://localhost:5173, http://lab-server ,',
    })
    expect(env.ALLOWED_ORIGINS).toEqual([
      'http://localhost:5173',
      'http://lab-server',
    ])
  })

  it('ALLOWED_ORIGINS が無ければ throw する', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: VALID_KEY,
    })).toThrow(/ALLOWED_ORIGINS/)
  })

  it('ALLOWED_ORIGINS がカンマと空白だけなら空とみなして throw する', () => {
    expect(() => loadEnv({
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: VALID_KEY,
      ALLOWED_ORIGINS: ' , , ,',
    })).toThrow(/ALLOWED_ORIGINS/)
  })

  it('必須変数が無ければ throw する', () => {
    expect(() => loadEnv({ PORT: '3000' })).toThrow(/DATABASE_URL_RW/)
  })

  it('ENCRYPTION_KEY が無ければ throw する', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })).toThrow(/ENCRYPTION_KEY/)
  })

  it('ENCRYPTION_KEY の長さが違えば throw する', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: 'abc',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })).toThrow(/ENCRYPTION_KEY/)
  })

  it('ENCRYPTION_KEY に hex 以外の文字があれば throw する', () => {
    expect(() => loadEnv({
      PORT: '3000',
      DATABASE_URL_RW: 'postgres://rw@localhost/dashboard',
      DATABASE_URL_RO: 'postgres://ro@localhost/dashboard',
      ENCRYPTION_KEY: 'z'.repeat(64),
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })).toThrow(/ENCRYPTION_KEY/)
  })

  it('MEDIA_* は default 値で読める', () => {
    const env = loadEnv({
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'http://localhost:5173',
    })
    expect(env.MEDIA_CONCURRENCY).toBe(3)
    expect(env.MEDIA_ANALYZE_TIMEOUT_SEC).toBe(300)
    expect(env.MEDIA_CACHE_MAX_AGE_DAYS).toBe(30)
    expect(env.MEDIA_SPECTROGRAM_MAX_WIDTH).toBe(4096)
    expect(env.MEDIA_WORKER_PORT).toBe(3100)
    expect(env.MEDIA_WORKER_URL).toBe('http://media-worker:3100')
  })

  it('boolean文字列のfalseをtrueとして扱わない', () => {
    const env = loadEnv({
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'http://localhost:5173',
      AUTH_COOKIE_SECURE: 'false',
    })
    expect(env.AUTH_COOKIE_SECURE).toBe(false)
  })

  it('OIDC groupのallow listとrole mappingを検証してparseする', () => {
    const env = loadEnv({
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'https://mado.example',
      OIDC_ALLOWED_GROUPS: 'mado-users, mado-admins,mado-users',
      OIDC_ROLE_MAPPING_JSON: '{"mado-admins":"admin","mado-users":"viewer"}',
      OIDC_AUTO_LINK_VERIFIED_EMAIL: 'true',
    })
    expect(env.OIDC_ALLOWED_GROUPS).toEqual(['mado-users', 'mado-admins'])
    expect(env.OIDC_ROLE_MAPPING_JSON).toEqual({ 'mado-admins': 'admin', 'mado-users': 'viewer' })
    expect(env.OIDC_AUTO_LINK_VERIFIED_EMAIL).toBe(true)
  })

  it('存在しないMado roleへのOIDC mappingを拒否する', () => {
    expect(() => loadEnv({
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'https://mado.example',
      OIDC_ROLE_MAPPING_JSON: '{"mado-users":"owner"}',
    })).toThrow(/OIDC_ROLE_MAPPING_JSON/)
  })

  it('productionでは認証無効を拒否する', () => {
    expect(() => loadEnv({
      MADO_ENV: 'production',
      AUTH_MODE: 'disabled',
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'https://mado.example',
    })).toThrow(/AUTH_MODE=disabled/)
  })

  it('productionでも認証を明示すれば起動できる', () => {
    const env = loadEnv({
      MADO_ENV: 'production',
      AUTH_MODE: 'local',
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'http://mado.internal',
    })
    expect(env.AUTH_MODE).toBe('local')
  })

  it('local authのrelease設定では未使用optional値の空文字を未設定として扱う', () => {
    const env = loadEnv({
      MADO_ENV: 'production',
      AUTH_MODE: 'local',
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      DATABASE_URL_RW_TEST: '',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'https://mado.example',
      OIDC_ISSUER_URL: '',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
      OIDC_REDIRECT_URI: '',
      OIDC_POST_LOGOUT_REDIRECT_URI: '',
      DATASET_REGISTRY_URL: 'http://registry.example',
      DATASET_REGISTRY_TOKEN: 'registry-token-at-least-16',
      MARQUEZ_URL: '',
    })
    expect(env.OIDC_ISSUER_URL).toBeUndefined()
    expect(env.OIDC_CLIENT_ID).toBeUndefined()
    expect(env.OIDC_CLIENT_SECRET).toBeUndefined()
    expect(env.OIDC_REDIRECT_URI).toBeUndefined()
    expect(env.OIDC_POST_LOGOUT_REDIRECT_URI).toBeUndefined()
    expect(env.MARQUEZ_URL).toBeUndefined()
    expect(env.DATASET_REGISTRY_URL).toBe('http://registry.example')
  })

  it('OIDC利用時はgroup allowlistを必須にする', () => {
    expect(() => loadEnv({
      AUTH_MODE: 'oidc',
      DATABASE_URL_RW: 'postgres://x',
      DATABASE_URL_RO: 'postgres://x',
      ENCRYPTION_KEY: '0'.repeat(64),
      ALLOWED_ORIGINS: 'https://mado.example',
    })).toThrow(/OIDC_ALLOWED_GROUPS/)
  })
})

describe('loadLineageEnv', () => {
  it('公開processに必要な最小設定だけを返す', () => {
    const env = loadLineageEnv({
      DATABASE_URL_RW: 'postgres://mado_lineage@postgres/dashboard',
      DATABASE_URL_RO: 'postgres://mado_lineage@postgres/dashboard',
      DATASET_REGISTRY_URL: 'http://registry-api:8080',
      DATASET_REGISTRY_TOKEN: 'registry-token-at-least-16',
      OIDC_CLIENT_SECRET: 'must-not-be-parsed',
      ENCRYPTION_KEY: VALID_KEY,
    })
    expect(env.LINEAGE_API_PORT).toBe(3001)
    expect(env).not.toHaveProperty('OIDC_CLIENT_SECRET')
    expect(env).not.toHaveProperty('ENCRYPTION_KEY')
  })

  it('Registry URLとtokenを必須にする', () => {
    expect(() => loadLineageEnv({
      DATABASE_URL_RW: 'postgres://mado_lineage@postgres/dashboard',
      DATABASE_URL_RO: 'postgres://mado_lineage@postgres/dashboard',
    })).toThrow(/DATASET_REGISTRY/)
  })
})
