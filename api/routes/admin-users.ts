import type { Hono } from 'hono'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import { randomToken } from '../lib/auth-crypto.js'
import type { AuthStore } from '../lib/auth-store.js'
import { requirePermission, getSessionPrincipal } from '../lib/rbac.js'
import { hashPassword } from '../lib/password.js'

export interface AdminUsersDeps {
  store: AuthStore
  audit: AuditWriter
}

const Role = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/)
const CreateBody = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  email: z.string().email().max(320).nullable().optional(),
  displayName: z.string().trim().min(1).max(128),
  roles: z.array(Role).max(16).default(['viewer']),
  password: z.string().min(12).max(1024).optional(),
})
const PatchBody = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  status: z.enum(['active', 'disabled']).optional(),
})
const RolesBody = z.object({ roles: z.array(Role).max(16) })
const ResetBody = z.object({ password: z.string().min(12).max(1024).optional() })

function meta(c: { req: { header(name: string): string | undefined } }) {
  return {
    ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? null,
    userAgent: c.req.header('User-Agent') ?? null,
    requestId: c.req.header('X-Request-Id') ?? null,
  }
}

export function mountAdminUsersRoutes(app: Hono, deps: AdminUsersDeps): void {
  app.use('/users', requirePermission('users:manage'))
  app.use('/users/*', requirePermission('users:manage'))

  app.get('/users', async c => c.json({ users: await deps.store.listUsers() }))

  app.post('/users', async c => {
    const principal = getSessionPrincipal(c)!
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    if (!await deps.store.rolesExist(parsed.data.roles)) return c.json({ error: 'unknown role' }, 400)
    try {
      const user = await deps.store.createUser({
        username: parsed.data.username,
        email: parsed.data.email,
        displayName: parsed.data.displayName,
        roles: parsed.data.roles,
        createdBy: principal.user.id,
      })
      if (parsed.data.password) {
        await deps.store.setLocalPassword(user.id, await hashPassword(parsed.data.password), true)
      }
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id }, action: 'user.create', outcome: 'success',
        resourceType: 'user', resourceId: user.id, details: { roles: parsed.data.roles }, ...meta(c),
      })
      return c.json({ user }, 201)
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === '23505') {
        return c.json({ error: 'username or email already exists' }, 409)
      }
      throw e
    }
  })

  app.patch('/users/:id', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const current = await deps.store.getUser(id)
    if (!current) return c.json({ error: 'user not found' }, 404)
    if (parsed.data.status === 'disabled' && current.roles.includes('admin')
        && !await deps.store.hasOtherActiveAdmin(id)) {
      return c.json({ error: 'cannot disable the last active admin' }, 409)
    }
    const user = await deps.store.updateUser(id, parsed.data)
    if (parsed.data.status === 'disabled') await deps.store.revokeUserSessions(id)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.update', outcome: 'success',
      resourceType: 'user', resourceId: id, details: { fields: Object.keys(parsed.data) }, ...meta(c),
    })
    return c.json({ user })
  })

  app.put('/users/:id/roles', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    const parsed = RolesBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    if (!await deps.store.rolesExist(parsed.data.roles)) return c.json({ error: 'unknown role' }, 400)
    const current = await deps.store.getUser(id)
    if (!current) return c.json({ error: 'user not found' }, 404)
    if (current.status === 'active' && current.roles.includes('admin')
        && !parsed.data.roles.includes('admin') && !await deps.store.hasOtherActiveAdmin(id)) {
      return c.json({ error: 'cannot remove the last active admin role' }, 409)
    }
    const user = await deps.store.setUserRoles(id, parsed.data.roles, principal.user.id)
    await deps.store.revokeUserSessions(id)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.roles.update', outcome: 'success',
      resourceType: 'user', resourceId: id, details: { roles: parsed.data.roles }, ...meta(c),
    })
    return c.json({ user })
  })

  app.post('/users/:id/reset-password', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    const parsed = ResetBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    if (!await deps.store.getUser(id)) return c.json({ error: 'user not found' }, 404)
    const temporaryPassword = parsed.data.password ?? `Mado-${randomToken(18)}`
    await deps.store.setLocalPassword(id, await hashPassword(temporaryPassword), true)
    await deps.store.revokeUserSessions(id)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.password.reset', outcome: 'success',
      resourceType: 'user', resourceId: id, ...meta(c),
    })
    // 自動生成時だけ一度返す。DB/auditには残さない。
    return c.json({ ok: true, temporaryPassword: parsed.data.password ? undefined : temporaryPassword })
  })
}
