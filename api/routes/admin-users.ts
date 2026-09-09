import type { Hono } from 'hono'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import { randomToken } from '../lib/auth-crypto.js'
import { LastActiveAdminError, type AuthStore } from '../lib/auth-store.js'
import { requirePermission, getSessionPrincipal } from '../lib/rbac.js'
import { requestMetadata } from '../lib/request-metadata.js'
import { hashPassword } from '../lib/password.js'
import { markAuditChangeCommitted } from '../lib/audit-activity.js'

export interface AdminUsersDeps {
  store: AuthStore
  audit: AuditWriter
  ssoRoleMapping: Record<string, string>
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
  displayName: z.string().trim().min(1).max(128).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict()
const RolesBody = z.object({ roles: z.array(Role).max(16) })
const ResetBody = z.object({ password: z.string().min(12).max(1024).optional() })

export function mountAdminUsersRoutes(app: Hono, deps: AdminUsersDeps): void {
  app.use('/users', requirePermission('users:manage'))
  app.use('/users/*', requirePermission('users:manage'))

  app.get('/users', async c => c.json({
    users: await deps.store.listUsers(),
    ssoRoleMapping: deps.ssoRoleMapping,
  }))

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
      markAuditChangeCommitted(c)
      if (parsed.data.password) {
        await deps.store.setLocalPassword(user.id, await hashPassword(parsed.data.password), true)
      }
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id }, action: 'user.create', outcome: 'success',
        resourceType: 'user', resourceId: user.id,
        details: {
          target: { displayName: user.displayName, username: user.username },
          changes: [{ field: 'roles', label: '権限', before: [], after: parsed.data.roles }],
        },
        ...requestMetadata(c),
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
    let result
    try {
      result = await deps.store.updateUserIfChanged(id, parsed.data)
    } catch (e) {
      if (e instanceof LastActiveAdminError) {
        return c.json({ error: 'cannot disable the last active admin' }, 409)
      }
      if (e instanceof Error && 'code' in e && e.code === '23505') {
        return c.json({ error: 'username already exists' }, 409)
      }
      throw e
    }
    if (!result) return c.json({ error: 'user not found' }, 404)
    if (result.changedFields.length === 0) return c.json({ user: result.user })
    markAuditChangeCommitted(c)
    const labels = { displayName: '表示名', username: 'ユーザーID', status: '状態' } as const
    const changes = result.changedFields.map(field => ({
      field,
      label: labels[field as keyof typeof labels],
      before: result.before[field as keyof typeof result.before],
      after: result.user[field as keyof typeof result.user],
    }))
    if (result.changedFields.includes('status') && result.user.status === 'disabled') {
      await deps.store.revokeUserSessions(id)
    }
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.update', outcome: 'success',
      resourceType: 'user', resourceId: id,
      details: {
        target: { displayName: result.before.displayName, username: result.before.username },
        changes,
      },
      ...requestMetadata(c),
    })
    return c.json({ user: result.user })
  })

  app.put('/users/:id/roles', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    const parsed = RolesBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    if (!await deps.store.rolesExist(parsed.data.roles)) return c.json({ error: 'unknown role' }, 400)
    const nextRoles = [...new Set(parsed.data.roles)].sort()
    let result
    try {
      result = await deps.store.setUserRolesIfChanged(id, nextRoles, principal.user.id)
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        return c.json({ error: 'cannot remove the last active admin role' }, 409)
      }
      throw error
    }
    if (!result) return c.json({ error: 'user not found' }, 404)
    if (result.changedFields.length === 0) return c.json({ user: result.user })
    markAuditChangeCommitted(c)
    await deps.store.revokeUserSessions(id)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.roles.update', outcome: 'success',
      resourceType: 'user', resourceId: id,
      details: {
        target: { displayName: result.before.displayName, username: result.before.username },
        changes: [{ field: 'roles', label: '権限', before: result.before.roles, after: result.user.roles }],
      },
      ...requestMetadata(c),
    })
    return c.json({ user: result.user })
  })

  app.post('/users/:id/reset-password', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    const parsed = ResetBody.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const current = await deps.store.getUser(id)
    if (!current) return c.json({ error: 'user not found' }, 404)
    if (current.authMethods.includes('sso') && !current.authMethods.includes('local')) {
      return c.json({ error: 'SSO user password is managed by the identity provider' }, 409)
    }
    const temporaryPassword = parsed.data.password ?? `Mado-${randomToken(18)}`
    await deps.store.setLocalPassword(id, await hashPassword(temporaryPassword), true)
    markAuditChangeCommitted(c)
    await deps.store.revokeUserSessions(id)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.password.reset', outcome: 'success',
      resourceType: 'user', resourceId: id,
      details: {
        target: { displayName: current.displayName, username: current.username },
        changes: [{ field: 'password', label: 'パスワード', before: null, after: '再発行・次回変更必須' }],
      },
      ...requestMetadata(c),
    })
    // 自動生成時だけ一度返す。DB/auditには残さない。
    return c.json({ ok: true, temporaryPassword: parsed.data.password ? undefined : temporaryPassword })
  })

  app.delete('/users/:id', async c => {
    const principal = getSessionPrincipal(c)!
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'invalid user id' }, 400)
    if (id === principal.user.id) return c.json({ error: 'cannot delete your own account' }, 409)
    const current = await deps.store.getUser(id)
    if (!current) return c.json({ error: 'user not found' }, 404)
    try {
      if (!await deps.store.deleteUser(id)) return c.json({ error: 'user not found' }, 404)
      markAuditChangeCommitted(c)
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        return c.json({ error: 'cannot delete the last active admin' }, 409)
      }
      throw error
    }
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'user.delete', outcome: 'success',
      resourceType: 'user', resourceId: id,
      details: {
        target: { displayName: current.displayName, username: current.username },
        changes: [{ field: 'account', label: 'アカウント', before: '存在', after: '削除' }],
      },
      ...requestMetadata(c),
    })
    return c.json({ ok: true })
  })
}
