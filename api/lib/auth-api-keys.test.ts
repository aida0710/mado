import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuthStore } from './auth-store.js'
import { createServiceAccountStore } from './auth-api-keys.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const auth = createAuthStore(pools.rw)
const store = createServiceAccountStore(pools.rw)

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('ServiceAccountStore', () => {
  it('key秘密を一度だけ返し、scope/namespace認証とrevokeを行う', async () => {
    const admin = await auth.createUser({ email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
    const account = await store.createAccount({ name: 'nemo', createdBy: admin.id })
    const key = await store.issueKey({
      accountId: account.id,
      name: 'prod',
      scopes: ['lineage:write'],
      namespaces: ['speech'],
      createdBy: admin.id,
    })
    expect(key.token).toMatch(/^mado_lin_[^.]+\.[A-Za-z0-9_-]+$/)
    const db = await pools.rw.query<{ secret_hash: Buffer }>(
      'SELECT secret_hash FROM service_account_keys WHERE id = $1', [key.id],
    )
    expect(db.rows[0].secret_hash).toHaveLength(32)
    expect(db.rows[0].secret_hash.toString()).not.toContain(key.token)

    const principal = await store.authenticate(key.token)
    expect(principal).toMatchObject({
      serviceAccountId: account.id,
      scopes: ['lineage:write'],
      namespaces: ['speech'],
    })
    expect(await store.authenticate(`${key.token}x`)).toBeNull()
    expect(await store.revokeKey(account.id, key.id)).toBe(true)
    expect(await store.authenticate(key.token)).toBeNull()
  })

  it('disabled accountの有効keyを拒否する', async () => {
    const admin = await auth.createUser({ email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
    const account = await store.createAccount({ name: 'disabled', createdBy: admin.id })
    const key = await store.issueKey({
      accountId: account.id, name: 'k', scopes: ['lineage:write'], namespaces: ['*'], createdBy: admin.id,
    })
    await store.updateAccount(account.id, { status: 'disabled' })
    expect(await store.authenticate(key.token)).toBeNull()
  })
})
