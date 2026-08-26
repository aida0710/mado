import type { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import type { AuthStore, SessionLifetime } from '../lib/auth-store.js'
import type { OidcProvider } from '../lib/auth-oidc.js'
import { randomToken } from '../lib/auth-crypto.js'
import { requireSession } from '../lib/auth-middleware.js'
import { SESSION_COOKIE, type RequestMetadata } from '../lib/auth-types.js'
import { getSessionPrincipal } from '../lib/rbac.js'
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../lib/password.js'

export interface AuthRouteConfig {
  localEnabled: boolean
  session: SessionLifetime & {
    cookieName?: string
    secure: boolean
  }
  loginFailureThreshold?: number
  loginLockSeconds?: number
  oidc?: OidcProvider
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

function requestMetadata(c: { req: { header(name: string): string | undefined } }): RequestMetadata {
  const forwarded = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
  return {
    ipAddress: forwarded || null,
    userAgent: c.req.header('User-Agent') ?? null,
    requestId: c.req.header('X-Request-Id') ?? null,
  }
}

function publicUser(user: {
  id: string
  username: string | null
  email: string | null
  displayName: string
  roles: string[]
  permissions: string[]
  mustChangePassword: boolean
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
  }
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
  cfg: AuthRouteConfig['session'],
): void {
  setCookie(c, cfg.cookieName ?? SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: cfg.absoluteSeconds,
  })
}

export function mountAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const threshold = deps.config.loginFailureThreshold ?? 5
  const lockSeconds = deps.config.loginLockSeconds ?? 15 * 60
  const cookieName = deps.config.session.cookieName ?? SESSION_COOKIE
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
    const credential = await deps.store.getLocalCredential(identifier)
    const locked = credential?.lockedUntil && credential.lockedUntil.getTime() > Date.now()
    const valid = await verifyPassword(credential?.passwordHash ?? await dummyHash, parsed.data.password)
    if (!credential || credential.status !== 'active' || locked || !valid) {
      if (credential && !locked) {
        await deps.store.recordFailedLogin(credential.id, threshold, lockSeconds)
      }
      await deps.audit.write({
        actor: { type: 'anonymous' }, action: 'auth.local.login', outcome: 'denied',
        details: { identifier: identifier.toLowerCase(), reason: locked ? 'locked' : 'invalid' },
        ...metadata,
      })
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
    await deps.audit.write({
      actor: { type: 'user', userId: credential.id }, action: 'auth.local.login', outcome: 'success',
      resourceType: 'session', resourceId: session.id, ...metadata,
    })
    return c.json({ user: publicUser(credential) })
  })

  app.get('/oidc/start', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const url = await deps.config.oidc.start(c.req.query('returnTo'))
    return c.redirect(url.href, 302)
  })

  app.get('/oidc/callback', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const metadata = requestMetadata(c)
    try {
      const profile = await deps.config.oidc.finish(new URL(c.req.url))
      let user = await deps.store.findOidcIdentity(profile.issuer, profile.subject)
      user ??= await deps.store.createOidcIdentityUser({
        issuer: profile.issuer,
        subject: profile.subject,
        email: profile.email,
        displayName: profile.displayName,
        defaultRole: 'viewer',
      })
      if (user.status !== 'active') throw new Error('user disabled')
      await deps.store.recordSuccessfulLogin(user.id)
      const session = await deps.store.createSession(user.id, deps.config.session, metadata)
      setSessionCookie(c, session.token, deps.config.session)
      await deps.audit.write({
        actor: { type: 'user', userId: user.id }, action: 'auth.oidc.login', outcome: 'success',
        resourceType: 'session', resourceId: session.id, ...metadata,
      })
      return c.redirect(profile.returnTo, 303)
    } catch (e) {
      await deps.audit.write({
        actor: { type: 'anonymous' }, action: 'auth.oidc.login', outcome: 'denied',
        // OAuth callback errorにはcode/state等が含まれ得るためmessageを監査ログへ入れない。
        details: { errorType: e instanceof Error ? e.name : 'unknown' }, ...metadata,
      })
      return c.json({ error: 'oidc login failed' }, 401)
    }
  })

  app.use('/me', sessionGuard)
  app.get('/me', c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    return c.json({ user: publicUser(principal.user) })
  })

  app.use('/logout', sessionGuard)
  app.post('/logout', async c => {
    const principal = getSessionPrincipal(c)
    const token = getCookie(c, cookieName)
    if (token) await deps.store.revokeSession(token)
    deleteCookie(c, cookieName, { path: '/', secure: deps.config.session.secure })
    if (principal) {
      await deps.audit.write({
        actor: { type: 'user', userId: principal.user.id }, action: 'auth.logout', outcome: 'success',
        resourceType: 'session', resourceId: principal.sessionId, ...requestMetadata(c),
      })
    }
    return c.json({ ok: true })
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
