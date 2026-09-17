import type { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import type { AuthStore, SessionLifetime } from '../lib/auth-store.js'
import type { OidcProvider } from '../lib/auth-oidc.js'
import { OidcAttemptLimitError } from '../lib/auth-oidc.js'
import { randomToken } from '../lib/auth-crypto.js'
import { AuthRateLimiter } from '../lib/auth-rate-limit.js'
import { requirePasswordChangeComplete, requireSession } from '../lib/auth-middleware.js'
import { SESSION_COOKIE } from '../lib/auth-types.js'
import { getSessionPrincipal } from '../lib/rbac.js'
import { requestMetadata } from '../lib/request-metadata.js'
import { markAuditChangeCommitted } from '../lib/audit-activity.js'
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../lib/password.js'

export interface AuthRouteConfig {
  localEnabled: boolean
  session: SessionLifetime & {
    cookieName?: string
    secure: boolean
  }
  rateLimiter?: AuthRateLimiter
  oidc?: OidcProvider
  oidcProvisioning?: {
    autoLinkVerifiedEmail: boolean
    allowedGroups: string[]
    roleMapping: Record<string, 'viewer' | 'curator' | 'operator' | 'admin'>
    defaultRole: 'viewer' | 'curator' | 'operator' | 'admin'
  }
}

export interface AuthRouteDeps {
  store: AuthStore
  audit: AuditWriter
  config: AuthRouteConfig
}

const LoginBody = z.object({
  identifier: z.string().trim().min(1).max(320).optional(),
  email: z.string().email().max(320).optional(),
  password: z.string().min(1).max(1024),
}).refine(value => Boolean(value.identifier || value.email))

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
})
const ProfileBody = z.object({
  signatureName: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128).optional(),
  username: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/).optional(),
})

function publicUser(user: {
  id: string
  username: string | null
  email: string | null
  displayName: string
  signatureName: string
  roles: string[]
  permissions: string[]
  mustChangePassword: boolean
  authMethods: Array<'local' | 'sso'>
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    signatureName: user.signatureName,
    roles: user.roles,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
    authMethods: user.authMethods,
  }
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
  session: AuthRouteConfig['session'],
): void {
  setCookie(c, session.cookieName ?? SESSION_COOKIE, token, {
    httpOnly: true,
    secure: session.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: session.absoluteSeconds,
  })
}

export function mountAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const cookieName = deps.config.session.cookieName ?? SESSION_COOKIE
  const limiter = deps.config.rateLimiter ?? new AuthRateLimiter()
  const oidcCookieName = deps.config.session.secure ? '__Host-mado_oidc_tx' : 'mado_oidc_tx'
  const sessionGuard = requireSession(deps.store, {
    idleSeconds: deps.config.session.idleSeconds,
    cookieName,
  })
  // 存在しないuserでもArgon2を1回計算し、email列挙のtiming差を小さくする。
  const dummyHash = hashPassword(`not-a-real-password-${randomToken(16)}`)

  app.get('/config', c => c.json({
    localEnabled: deps.config.localEnabled,
    oidc: deps.config.oidc
      ? { enabled: true, id: deps.config.oidc.id, label: deps.config.oidc.label }
      : { enabled: false },
  }))

  app.post('/local/login', async c => {
    if (!deps.config.localEnabled) return c.json({ error: 'local login disabled' }, 404)
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid identifier or password' }, 401)
    const identifier = parsed.data.identifier ?? parsed.data.email!
    const metadata = requestMetadata(c)
    const ipKey = `login:ip:${metadata.ipAddress ?? 'unknown'}`
    if (!limiter.consume(ipKey, 30, 60_000)) {
      c.header('Retry-After', '60')
      return c.json({ error: 'too many login attempts' }, 429)
    }
    const credential = await deps.store.getLocalCredential(identifier)
    const checked = await limiter.passwordCheck(async () =>
      verifyPassword(credential?.passwordHash ?? await dummyHash, parsed.data.password))
    if (!checked.accepted) {
      c.header('Retry-After', '1')
      return c.json({ error: 'authentication busy' }, 429)
    }
    if (!credential || credential.status !== 'active' || !checked.value) {
      return c.json({ error: 'invalid identifier or password' }, 401)
    }

    if (passwordNeedsRehash(credential.passwordHash)) {
      await deps.store.setLocalPassword(
        credential.id,
        await hashPassword(parsed.data.password),
        credential.mustChangePassword,
      )
    }
    await deps.store.recordSuccessfulLogin(credential.id)
    const session = await deps.store.createSession(credential.id, deps.config.session, metadata)
    setSessionCookie(c, session.token, deps.config.session)
    return c.json({ user: publicUser(credential) })
  })

  app.get('/oidc/start', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const metadata = requestMetadata(c)
    if (!limiter.consume(`oidc:start:${metadata.ipAddress ?? 'unknown'}`, 20, 60_000)) {
      c.header('Retry-After', '60')
      return c.json({ error: 'too many oidc attempts' }, 429)
    }
    const existing = getCookie(c, oidcCookieName)
    const browserBinding = existing && existing.length >= 32 && existing.length <= 256
      ? existing : randomToken(32)
    try {
      const url = await deps.config.oidc.start(c.req.query('returnTo'), browserBinding)
      setCookie(c, oidcCookieName, browserBinding, {
        httpOnly: true, secure: deps.config.session.secure, sameSite: 'Lax', path: '/', maxAge: 300,
      })
      return c.redirect(url.href, 302)
    } catch (error) {
      if (error instanceof OidcAttemptLimitError) {
        c.header('Retry-After', '300')
        return c.json({ error: 'too many oidc attempts' }, 429)
      }
      throw error
    }
  })

  app.get('/oidc/callback', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const metadata = requestMetadata(c)
    const browserBinding = getCookie(c, oidcCookieName)
    deleteCookie(c, oidcCookieName, { path: '/', secure: deps.config.session.secure })
    try {
      if (!browserBinding) throw new Error('oidc browser binding missing')
      const profile = await deps.config.oidc.finish(new URL(c.req.url), browserBinding)
      const policy = deps.config.oidcProvisioning ?? {
        autoLinkVerifiedEmail: false, allowedGroups: [], roleMapping: {}, defaultRole: 'viewer' as const,
      }
      if (policy.allowedGroups.length === 0
          || !profile.groups.some(group => policy.allowedGroups.includes(group))) {
        throw new Error('oidc group not allowed')
      }
      const mappedRoles = [...new Set(profile.groups.map(group => policy.roleMapping[group]).filter(Boolean))]
      const roleMappingEnabled = Object.keys(policy.roleMapping).length > 0
      const provisioned = await deps.store.provisionOidcUser({
        issuer: profile.issuer,
        subject: profile.subject,
        email: profile.email,
        emailVerified: profile.emailVerified,
        username: profile.username,
        displayName: profile.displayName,
        groups: profile.groups,
        autoLinkVerifiedEmail: policy.autoLinkVerifiedEmail,
        defaultRole: policy.defaultRole,
        managedRoles: roleMappingEnabled
          ? (mappedRoles.length > 0 ? mappedRoles : [policy.defaultRole])
          : undefined,
      })
      const user = provisioned.user
      if (user.status !== 'active') throw new Error('user disabled')
      const session = await deps.store.createSession(user.id, deps.config.session, metadata, {
        issuer: profile.issuer, subject: profile.subject, sid: profile.sid,
      })
      setSessionCookie(c, session.token, deps.config.session)
      if (provisioned.created || provisioned.linkedExisting || provisioned.profileChanged) {
        await deps.audit.write({
          actor: { type: 'user', userId: user.id }, action: 'auth.oidc.sync', outcome: 'success',
          resourceType: 'user', resourceId: user.id,
          details: {
            created: provisioned.created,
            linkedExisting: provisioned.linkedExisting,
            rolesBefore: provisioned.rolesBefore,
            rolesAfter: user.roles,
          },
          ...metadata,
        })
      }
      return c.redirect(profile.returnTo, 303)
    } catch {
      return c.json({ error: 'oidc login failed' }, 401)
    }
  })

  app.get('/oidc/frontchannel-logout', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const issuer = c.req.query('iss')
    const sid = c.req.query('sid')
    if (!issuer || !sid || sid.length > 512 || !deps.config.oidc.matchesIssuer(issuer)) {
      return c.json({ error: 'invalid frontchannel logout' }, 400)
    }
    const revoked = await deps.store.revokeOidcSessions({ issuer: deps.config.oidc.issuer, sid })
    deleteCookie(c, cookieName, { path: '/', secure: deps.config.session.secure })
    if (revoked > 0) {
      await deps.audit.write({
        actor: { type: 'system' }, action: 'auth.oidc.session_revoke', outcome: 'success',
        resourceType: 'oidc_session', resourceId: sid, details: { channel: 'front', revoked },
        ...requestMetadata(c),
      })
    }
    c.header('Cache-Control', 'no-store')
    return c.body(null, 204)
  })

  app.post('/oidc/backchannel-logout', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const announced = Number(c.req.header('Content-Length') ?? 0)
    if (Number.isFinite(announced) && announced > 20_000) return c.json({ error: 'request too large' }, 413)
    try {
      const body = await c.req.text()
      if (body.length > 20_000) return c.json({ error: 'request too large' }, 413)
      const logoutToken = new URLSearchParams(body).get('logout_token')
      if (!logoutToken) return c.json({ error: 'logout_token missing' }, 400)
      const claims = await deps.config.oidc.verifyBackchannelLogoutToken(logoutToken)
      const result = await deps.store.applyOidcBackchannelLogout(claims)
      if (!result.accepted) {
        return c.json({ error: 'logout_token already used' }, 400)
      }
      if (result.revoked > 0) {
        await deps.audit.write({
          actor: { type: 'system' }, action: 'auth.oidc.session_revoke', outcome: 'success',
          resourceType: 'oidc_identity', resourceId: claims.subject ?? claims.sid,
          details: { channel: 'back', revoked: result.revoked }, ...requestMetadata(c),
        })
      }
      c.header('Cache-Control', 'no-store')
      return c.body(null, 204)
    } catch {
      return c.json({ error: 'invalid logout_token' }, 400)
    }
  })

  app.use('/me', sessionGuard)
  app.get('/me', c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ user: publicUser(principal.user) })
  })

  app.use('/profile', sessionGuard)
  app.use('/profile', requirePasswordChangeComplete())
  app.put('/profile', async c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    const parsed = ProfileBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid profile' }, 400)
    let result
    try {
      result = await deps.store.updateProfileIfChanged(principal.user.id, {
        displayName: parsed.data.displayName,
        username: parsed.data.username,
        signatureName: parsed.data.signatureName,
      })
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === '23505') {
        return c.json({ error: 'username already exists' }, 409)
      }
      throw e
    }
    if (!result) return c.json({ error: 'user not found' }, 404)
    if (result.changedFields.length === 0) return c.json({ user: publicUser(result.user) })
    markAuditChangeCommitted(c)
    const labels = { displayName: '表示名', username: 'ユーザーID', signatureName: '署名' } as const
    const changes = result.changedFields.map(field => ({
      field,
      label: labels[field as keyof typeof labels],
      before: result.before[field as keyof typeof result.before],
      after: result.user[field as keyof typeof result.user],
    }))
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id },
      action: 'auth.profile.update', outcome: 'success',
      resourceType: 'user', resourceId: principal.user.id,
      details: { changes }, ...requestMetadata(c),
    })
    return c.json({ user: publicUser(result.user) })
  })

  app.use('/logout', sessionGuard)
  app.post('/logout', async c => {
    const token = getCookie(c, cookieName)
    const oidcContext = token ? await deps.store.getSessionOidcContext(token) : null
    if (token) await deps.store.revokeSession(token)
    deleteCookie(c, cookieName, { path: '/', secure: deps.config.session.secure })
    const logoutUrl = oidcContext && deps.config.oidc?.matchesIssuer(oidcContext.issuer)
      ? (await deps.config.oidc.logoutUrl()).href
      : null
    return c.json({ ok: true, logoutUrl })
  })

  app.use('/change-password', sessionGuard)
  app.post('/change-password', async c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'local credential not available' }, 400)
    const parsed = ChangePasswordBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid password' }, 400)
    const identifier = principal.user.username ?? principal.user.email
    if (!identifier) return c.json({ error: 'local credential not available' }, 400)
    const credential = await deps.store.getLocalCredential(identifier)
    if (!credential || !await verifyPassword(credential.passwordHash, parsed.data.currentPassword)) {
      return c.json({ error: 'current password is incorrect' }, 400)
    }
    const hash = await hashPassword(parsed.data.newPassword).catch(() => null)
    if (!hash) return c.json({ error: 'invalid new password' }, 400)
    await deps.store.setLocalPassword(principal.user.id, hash, false)
    markAuditChangeCommitted(c)
    await deps.store.revokeUserSessions(principal.user.id)
    const metadata = requestMetadata(c)
    const session = await deps.store.createSession(principal.user.id, deps.config.session, metadata)
    setSessionCookie(c, session.token, deps.config.session)
    await deps.audit.write({
      actor: { type: 'user', userId: principal.user.id }, action: 'auth.password.change', outcome: 'success',
      resourceType: 'user', resourceId: principal.user.id, ...metadata,
    })
    return c.json({ ok: true })
  })
}
