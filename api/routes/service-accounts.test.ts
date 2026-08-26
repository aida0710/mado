import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createServiceAccountStore } from '../lib/auth-api-keys.js'
import { createAuthStore } from '../lib/auth-store.js'
import { setSessionPrincipal } from '../lib/rbac.js'
import { mountServiceAccountRoutes } from './service-accounts.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const auth = createAuthStore(pools.rw)
const keys = createServiceAccountStore(pools.rw)
const audit = createAuditWriter(pools.rw)
let app: Hono

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
  const admin = await auth.createUser({ email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
  app = new Hono()
  app.use('*', async (c, next) => {
    setSessionPrincipal(c, { kind: 'user', sessionId: 'test', user: admin })
    await next()
  })
  mountServiceAccountRoutes(app, { store: keys, audit })
})
afterAll(() => closePools(pools))

describe('service account routes', () => {
  it('account/keyを作成し、秘密値は発行responseだけに含める', async () => {
    const accountRes = await app.request('/service-accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nemo' }),
    })
    expect(accountRes.status).toBe(201)
    const account = (await accountRes.json() as { account: { id: string } }).account
    const keyRes = await app.request(`/service-accounts/${account.id}/keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'prod', scopes: ['lineage:write'], namespaces: ['speech'] }),
    })
    expect(keyRes.status).toBe(201)
    const issued = (await keyRes.json() as { key: { token: string } }).key
    expect(issued.token).toMatch(/^mado_lin_/)

    const list = await app.request(`/service-accounts/${account.id}/keys`)
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).not.toContain(issued.token)
    expect(await keys.authenticate(issued.token)).not.toBeNull()
  })
})
