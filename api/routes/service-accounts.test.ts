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

describe('Service Account route', () => {
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

  it('同じaccount内容の再保存はauditへ残さない', async () => {
    const admin = (await auth.listUsers())[0]
    const account = await keys.createAccount({ name: 'same', description: 'desc', createdBy: admin.id })
    const response = await app.request(`/service-accounts/${account.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'same', description: 'desc', status: 'active' }),
    })
    expect(response.status).toBe(200)
    const events = await pools.rw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE resource_id = $1 AND action = 'service_account.update'`, [account.id],
    )
    expect(events.rows[0].count).toBe('0')
  })

  it('metrics:readのkeyはnamespaceなしで発行し、namespaceの有無がscopeと合わない依頼を拒否する', async () => {
    const admin = (await auth.listUsers())[0]
    const account = await keys.createAccount({ name: 'prometheus', createdBy: admin.id })
    const issue = (body: unknown) => app.request(`/service-accounts/${account.id}/keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })

    const metrics = await issue({ name: 'grafana', scopes: ['metrics:read'] })
    expect(metrics.status).toBe(201)
    const issued = (await metrics.json() as { key: { token: string; scopes: string[]; namespaces: string[] } }).key
    expect(issued.scopes).toEqual(['metrics:read'])
    expect(issued.namespaces).toEqual([])
    expect((await keys.authenticate(issued.token))?.scopes).toEqual(['metrics:read'])

    expect((await issue({ name: 'lineage', scopes: ['lineage:write'] })).status).toBe(400)
    expect((await issue({ name: 'mixed', scopes: ['metrics:read'], namespaces: ['speech'] })).status).toBe(400)
    expect((await issue({ name: 'write', scopes: ['metrics:write'] })).status).toBe(400)
  })
})
