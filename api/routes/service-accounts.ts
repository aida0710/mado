import type { Hono } from 'hono'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import type { ServiceAccountStore } from '../lib/auth-api-keys.js'
import { getSessionPrincipal, requirePermission } from '../lib/rbac.js'
import { requestMetadata } from '../lib/request-metadata.js'

export interface ServiceAccountsDeps {
  store: ServiceAccountStore
  audit: AuditWriter
}

const CreateAccount = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2048).default(''),
})
const PatchAccount = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().max(2048).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})
const CreateKey = z.object({
  name: z.string().trim().min(1).max(128),
  scopes: z.array(z.enum(['lineage:write'])).min(1).max(16),
  namespaces: z.array(z.string().min(1).max(512)).min(1).max(128),
  expiresAt: z.string().datetime().nullable().optional(),
})

export function mountServiceAccountRoutes(app: Hono, deps: ServiceAccountsDeps): void {
  app.use('/service-accounts', requirePermission('service_accounts:manage'))
  app.use('/service-accounts/*', requirePermission('service_accounts:manage'))

  app.get('/service-accounts', async c => c.json({ accounts: await deps.store.listAccounts() }))

  app.post('/service-accounts', async c => {
    const principal = getSessionPrincipal(c)!
    const parsed = CreateAccount.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    try {
      const account = await deps.store.createAccount({ ...parsed.data, createdBy: principal.user.id })
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id }, action: 'service_account.create', outcome: 'success',
        resourceType: 'service_account', resourceId: account.id, ...requestMetadata(c),
      })
      return c.json({ account }, 201)
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === '23505') {
        return c.json({ error: 'service account name already exists' }, 409)
      }
      throw e
    }
  })

  app.patch('/service-accounts/:id', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid account id' }, 400)
    const parsed = PatchAccount.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const account = await deps.store.updateAccount(id, parsed.data)
    if (!account) return c.json({ error: 'service account not found' }, 404)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'service_account.update', outcome: 'success',
      resourceType: 'service_account', resourceId: id, details: { fields: Object.keys(parsed.data) }, ...requestMetadata(c),
    })
    return c.json({ account })
  })

  app.get('/service-accounts/:id/keys', async c => {
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid account id' }, 400)
    return c.json({ keys: await deps.store.listKeys(id) })
  })

  app.post('/service-accounts/:id/keys', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid account id' }, 400)
    const parsed = CreateKey.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
    if (expiresAt && expiresAt.getTime() <= Date.now()) return c.json({ error: 'expiresAt must be in the future' }, 400)
    try {
      const key = await deps.store.issueKey({
        accountId: id,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        namespaces: parsed.data.namespaces,
        expiresAt,
        createdBy: principal.user.id,
      })
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id }, action: 'service_account.key.issue', outcome: 'success',
        resourceType: 'service_account_key', resourceId: key.id,
        details: { serviceAccountId: id, scopes: key.scopes, namespaces: key.namespaces, tokenPrefix: key.tokenPrefix },
        ...requestMetadata(c),
      })
      return c.json({ key }, 201)
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === '23503') {
        return c.json({ error: 'service account not found' }, 404)
      }
      throw e
    }
  })

  app.delete('/service-accounts/:accountId/keys/:keyId', async c => {
    const principal = getSessionPrincipal(c)!
    const accountId = c.req.param('accountId')
    const keyId = c.req.param('keyId')
    if (!z.string().uuid().safeParse(accountId).success || !z.string().uuid().safeParse(keyId).success) {
      return c.json({ error: 'invalid id' }, 400)
    }
    if (!await deps.store.revokeKey(accountId, keyId)) return c.json({ error: 'key not found or already revoked' }, 404)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'service_account.key.revoke', outcome: 'success',
      resourceType: 'service_account_key', resourceId: keyId, details: { serviceAccountId: accountId }, ...requestMetadata(c),
    })
    return c.json({ ok: true })
  })
}
