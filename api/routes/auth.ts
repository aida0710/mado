import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AuditWriter } from '../lib/audit.js'
import type { CredentialStore } from '../lib/auth-credential-store.js'
import { SessionUserUnavailableError, type SessionLifetime, type SessionStore } from '../lib/auth-session-store.js'
import type { UserStore } from '../lib/auth-user-store.js'
import type { OidcProvider } from '../lib/auth-oidc.js'
import { OIDC_TRANSACTION_TTL_SECONDS, OidcAttemptLimitError } from '../lib/auth-oidc.js'
import {
  OidcLoginDeniedError, resolveOidcRoles, type OidcProvisioning, type OidcRolePolicy,
} from '../lib/auth-oidc-provisioning.js'
import { isPlausibleOpaqueToken, randomToken } from '../lib/auth-crypto.js'
import { AuthRateLimiter } from '../lib/auth-rate-limit.js'
import { requirePasswordChangeComplete, requireSession } from '../lib/auth-middleware.js'
import { oidcTransactionCookieName, sessionCookieName } from '../lib/auth-types.js'
import { getSessionPrincipal } from '../lib/rbac.js'
import { requestMetadata } from '../lib/request-metadata.js'
import { auditActivity, markAuditChangeCommitted, writeDedicatedAudit } from '../lib/audit-activity.js'
import {
  PASSWORD_MAX_BYTES, hashPassword, isAcceptablePasswordLength, passwordNeedsRehash, verifyPassword,
} from '../lib/password.js'

// 送信元 IP ごとの試行回数の上限。人が打ち直すには十分で、総当たりには遅い回数にする。
const LOCAL_LOGIN_LIMIT = { attempts: 30, windowMs: 60_000 }
const OIDC_START_LIMIT = { attempts: 20, windowMs: 60_000 }
// 本人の現在のパスワードの確認は User ごとに数える。盗まれた session からの総当たりを遅くするため。
const CHANGE_PASSWORD_LIMIT = { attempts: 10, windowMs: 15 * 60_000 }

export interface AuthRouteConfig {
  localEnabled: boolean
  session: SessionLifetime & { secure: boolean }
  rateLimiter?: AuthRateLimiter
  oidc?: OidcProvider
  oidcLoginPolicy?: OidcRolePolicy & { autoLinkVerifiedEmail: boolean }
}

export interface AuthRouteDeps {
  users: Pick<UserStore, 'updateProfile'>
  credentials: CredentialStore
  sessions: SessionStore
  oidcProvisioning: OidcProvisioning
  audit: AuditWriter
  config: AuthRouteConfig
}

// Argon2 の同時実行が上限に達したときに、少し待ってから打ち直してもらう秒数。
const PASSWORD_CHECK_BUSY_RETRY_SECONDS = 1

/** 回数制限に当たったことを 429 で返す。Retry-After は window の長さ。 */
function tooManyAttempts(c: Context, limit: { windowMs: number }, error: string): Response {
  c.header('Retry-After', String(limit.windowMs / 1000))
  return c.json({ error }, 429)
}

/** Argon2 の同時実行が上限に達しているので、少し待ってもらう。 */
function passwordCheckBusy(c: Context): Response {
  c.header('Retry-After', String(PASSWORD_CHECK_BUSY_RETRY_SECONDS))
  return c.json({ error: 'authentication busy' }, 429)
}

/** SSO の callback が失敗した理由を、秘密値を含めずに log へ出すための分類。 */
function oidcFailureReason(error: unknown): string {
  if (error instanceof OidcLoginDeniedError) return error.reason
  if (error instanceof SessionUserUnavailableError) return 'user_disabled'
  return error instanceof Error ? error.message : 'unknown'
}

// 入力されたパスワードも、保存できる長さと同じ UTF-8 の byte 数で上限を見る。
const EnteredPassword = z.string().min(1).refine(password => Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES)

const LoginBody = z.object({
  identifier: z.string().trim().min(1).max(320).optional(),
  email: z.string().email().max(320).optional(),
  password: EnteredPassword,
}).refine(value => Boolean(value.identifier || value.email))

const ChangePasswordBody = z.object({
  currentPassword: EnteredPassword,
  newPassword: z.string().refine(password => isAcceptablePasswordLength(password)),
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
  setCookie(c, sessionCookieName(session.secure), token, {
    httpOnly: true,
    secure: session.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: session.absoluteSeconds,
  })
}

export function mountAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
  const cookieName = sessionCookieName(deps.config.session.secure)
  const limiter = deps.config.rateLimiter ?? new AuthRateLimiter()
  const oidcCookieName = oidcTransactionCookieName(deps.config.session.secure)
  const sessionGuard = requireSession(deps.sessions, {
    idleSeconds: deps.config.session.idleSeconds,
    cookieName,
  })
  // 本人による変更も、/api/internal と同じく変更の前に監査の intent を残す。
  const auditChanges = auditActivity(deps.audit)
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
    if (!limiter.consume(ipKey, LOCAL_LOGIN_LIMIT.attempts, LOCAL_LOGIN_LIMIT.windowMs)) {
      return tooManyAttempts(c, LOCAL_LOGIN_LIMIT, 'too many login attempts')
    }
    const credential = await deps.credentials.findLocalCredentialByLogin(identifier)
    const checked = await limiter.passwordCheck(async () =>
      verifyPassword(credential?.passwordHash ?? await dummyHash, parsed.data.password))
    if (!checked.accepted) return passwordCheckBusy(c)
    if (!credential || credential.status !== 'active' || !checked.value) {
      return c.json({ error: 'invalid identifier or password' }, 401)
    }

    // 検証の間にパスワードが変わっていたら、古いパスワードで session を作らない。
    const session = await deps.credentials.openLocalSession({
      userId: credential.id,
      verifiedPasswordHash: credential.passwordHash,
      rehashedPasswordHash: passwordNeedsRehash(credential.passwordHash)
        ? await hashPassword(parsed.data.password) : undefined,
      session: { lifetime: deps.config.session, metadata },
    })
    if (!session) return c.json({ error: 'invalid identifier or password' }, 401)
    setSessionCookie(c, session.token, deps.config.session)
    return c.json({ user: publicUser(credential) })
  })

  app.get('/oidc/start', async c => {
    if (!deps.config.oidc) return c.json({ error: 'oidc disabled' }, 404)
    const metadata = requestMetadata(c)
    if (!limiter.consume(`oidc:start:${metadata.ipAddress ?? 'unknown'}`, OIDC_START_LIMIT.attempts, OIDC_START_LIMIT.windowMs)) {
      return tooManyAttempts(c, OIDC_START_LIMIT, 'too many oidc attempts')
    }
    const existing = getCookie(c, oidcCookieName)
    const browserBinding = existing && isPlausibleOpaqueToken(existing) ? existing : randomToken(32)
    try {
      const url = await deps.config.oidc.start(c.req.query('returnTo'), browserBinding)
      setCookie(c, oidcCookieName, browserBinding, {
        httpOnly: true, secure: deps.config.session.secure, sameSite: 'Lax', path: '/',
        maxAge: OIDC_TRANSACTION_TTL_SECONDS,
      })
      return c.redirect(url.href, 302)
    } catch (error) {
      if (error instanceof OidcAttemptLimitError) {
        c.header('Retry-After', String(OIDC_TRANSACTION_TTL_SECONDS))
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
      const policy = deps.config.oidcLoginPolicy ?? {
        autoLinkVerifiedEmail: false, allowedGroups: [], roleMapping: {}, defaultRole: 'viewer' as const,
      }
      const roles = resolveOidcRoles(policy, profile.groups)
      if (!roles.allowed) throw new OidcLoginDeniedError('group_not_allowed')
      const provisioned = await deps.oidcProvisioning.provisionOidcUser({
        issuer: profile.issuer,
        subject: profile.subject,
        email: profile.email,
        emailVerified: profile.emailVerified,
        username: profile.username,
        displayName: profile.displayName,
        groups: profile.groups,
        autoLinkVerifiedEmail: policy.autoLinkVerifiedEmail,
        defaultRole: policy.defaultRole,
        managedRoles: roles.managedRoles,
        metadata,
      })
      const session = await deps.sessions.createSession({
        userId: provisioned.user.id,
        lifetime: deps.config.session,
        metadata,
        oidc: { issuer: profile.issuer, subject: profile.subject, sid: profile.sid },
      })
      setSessionCookie(c, session.token, deps.config.session)
      return c.redirect(profile.returnTo, 303)
    } catch (error) {
      // 利用者には理由を区別せず返す。「SSO で入れない」と言われたときに運用者が切り分けられるよう、
      // 理由だけを log に残す (token や code は含めない)。
      console.warn('oidc login failed', { reason: oidcFailureReason(error), requestId: metadata.requestId })
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
    await deps.sessions.revokeOidcSessions({ issuer: deps.config.oidc.issuer, sid }, requestMetadata(c))
    deleteCookie(c, cookieName, { path: '/', secure: deps.config.session.secure })
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
      const result = await deps.sessions.applyOidcBackchannelLogout(claims, requestMetadata(c))
      if (!result.accepted) {
        return c.json({ error: 'logout_token already used' }, 400)
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
  app.use('/profile', auditChanges)
  app.put('/profile', async c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    const parsed = ProfileBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid profile' }, 400)
    let result
    try {
      result = await deps.users.updateProfile(principal.user.id, {
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
    await writeDedicatedAudit(c, deps.audit, {
      actor: { type: 'user', userId: principal.user.id },
      action: 'auth.profile.update', outcome: 'success',
      resourceType: 'user', resourceId: principal.user.id,
      details: { changes }, ...requestMetadata(c),
    })
    return c.json({ user: publicUser(result.user) })
  })

  /**
   * SSO の session なら、IdP 側もサインアウトさせる URL を返す。Mado の session はもう失効しているので、
   * IdP に届かず URL を作れなくても失敗にはしない。ただし IdP 側の session は残るので、
   * 画面で伝えられるよう unavailable を返す。
   */
  async function idpLogout(oidcContext: { issuer: string } | null): Promise<{ url: string | null; unavailable: boolean }> {
    if (!oidcContext || !deps.config.oidc?.matchesIssuer(oidcContext.issuer)) return { url: null, unavailable: false }
    try {
      return { url: (await deps.config.oidc.logoutUrl()).href, unavailable: false }
    } catch (error) {
      console.warn('oidc logout url unavailable', { reason: oidcFailureReason(error) })
      return { url: null, unavailable: true }
    }
  }

  app.use('/logout', sessionGuard)
  app.post('/logout', async c => {
    const token = getCookie(c, cookieName)
    const oidcContext = token ? await deps.sessions.getSessionOidcContext(token) : null
    if (token) await deps.sessions.revokeSession(token)
    deleteCookie(c, cookieName, { path: '/', secure: deps.config.session.secure })
    const idp = await idpLogout(oidcContext)
    return c.json({ ok: true, logoutUrl: idp.url, idpLogoutUnavailable: idp.unavailable })
  })

  // Local login を無効にした (SSO 専用の) 運用でも残す。検証済み email で SSO へ連携した Local User や、
  // 管理者がパスワードを再発行した User は、変更を必須にされたままだと通常の API を使えないため。
  app.use('/change-password', sessionGuard)
  app.use('/change-password', auditChanges)
  app.post('/change-password', async c => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    const parsed = ChangePasswordBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid password' }, 400)
    const userId = principal.user.id
    if (!limiter.consume(`change-password:user:${userId}`, CHANGE_PASSWORD_LIMIT.attempts, CHANGE_PASSWORD_LIMIT.windowMs)) {
      return tooManyAttempts(c, CHANGE_PASSWORD_LIMIT, 'too many password change attempts')
    }
    const credential = await deps.credentials.getLocalCredential(userId)
    if (!credential) return c.json({ error: 'local credential not available' }, 400)
    const checked = await limiter.passwordCheck(async () =>
      await verifyPassword(credential.passwordHash, parsed.data.currentPassword)
        ? hashPassword(parsed.data.newPassword)
        : null)
    if (!checked.accepted) return passwordCheckBusy(c)
    if (!checked.value) return c.json({ error: 'current password is incorrect' }, 400)

    const metadata = requestMetadata(c)
    const session = await deps.credentials.changeLocalPassword({
      userId,
      verifiedPasswordHash: credential.passwordHash,
      newPasswordHash: checked.value,
      session: { lifetime: deps.config.session, metadata },
    })
    if (!session) return c.json({ error: 'password was changed by another request' }, 409)
    markAuditChangeCommitted(c)
    setSessionCookie(c, session.token, deps.config.session)
    await writeDedicatedAudit(c, deps.audit, {
      actor: { type: 'user', userId }, action: 'auth.password.change', outcome: 'success',
      resourceType: 'user', resourceId: userId, ...metadata,
    })
    return c.json({ ok: true })
  })
}
