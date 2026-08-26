import type { Context, MiddlewareHandler } from 'hono'
import type { AuditWriter } from './audit.js'
import { getSessionPrincipal } from './rbac.js'

interface Activity {
  action: string
  resourceType: string
  resourceId: string | null
  /** Route自身がsuccess auditを書く場合、共通middlewareは失敗・拒否だけ補完する。 */
  dedicatedSuccessAudit?: boolean
}

function decoded(value: string | undefined): string | null {
  if (!value) return null
  try { return decodeURIComponent(value) } catch { return value }
}

function pathParts(pathname: string): string[] {
  const path = pathname.replace(/^\/api\/internal(?=\/|$)/, '')
  return path.split('/').filter(Boolean)
}

export function classifyActivity(method: string, pathname: string): Activity | null {
  const p = pathParts(pathname)
  const verb = method.toUpperCase()

  if (p[0] === 'connections') {
    if (verb === 'POST' && p.length === 1) return { action: 'connection.create', resourceType: 'connection', resourceId: null }
    if (verb === 'PUT' && p[2] === 'default') return { action: 'connection.default.set', resourceType: 'connection', resourceId: decoded(p[1]) }
    if (verb === 'PUT' && p.length === 2) return { action: 'connection.update', resourceType: 'connection', resourceId: decoded(p[1]) }
    if (verb === 'DELETE' && p.length === 2) return { action: 'connection.delete', resourceType: 'connection', resourceId: decoded(p[1]) }
  }
  if (verb === 'PUT' && p[0] === 'notes' && p[1]) {
    return { action: 'note.update', resourceType: 'note', resourceId: decoded(p[1]) }
  }
  if (p[0] === 'tags') {
    if (verb === 'POST' && p.length === 1) return { action: 'tag.create', resourceType: 'tag', resourceId: null }
    if (verb === 'PUT' && p[1]) return { action: 'tag.update', resourceType: 'tag', resourceId: decoded(p[1]) }
    if (verb === 'DELETE' && p[1]) return { action: 'tag.delete', resourceType: 'tag', resourceId: decoded(p[1]) }
  }
  if (p[0] === 'storage' && p[1]) {
    const connectionId = decoded(p[1])
    if (verb === 'PUT' && p[2] === 'readme') return { action: 'storage.readme.update', resourceType: 'connection', resourceId: connectionId }
    if ((verb === 'PUT' || verb === 'DELETE') && p[2] === 'favorites') {
      return { action: verb === 'PUT' ? 'storage.favorite.add' : 'storage.favorite.remove', resourceType: 'storage_path', resourceId: `${connectionId}/${decoded(p[3]) ?? ''}` }
    }
    if ((verb === 'PUT' || verb === 'DELETE') && p[2] === 'tags') {
      return { action: verb === 'PUT' ? 'storage.tag.assign' : 'storage.tag.remove', resourceType: 'storage_path', resourceId: connectionId }
    }
    if (verb === 'POST' && p[2] === 'scan') return { action: 'storage.scan.start', resourceType: 'connection', resourceId: connectionId }
    if (verb === 'GET' && p[2] === 'preview' && ['raw', 'tar', 'tar-entry'].includes(p[3] ?? '')) {
      return { action: `storage.download.${p[3]}`, resourceType: 'connection', resourceId: connectionId }
    }
  }
  if (verb === 'PUT' && p[0] === 'settings' && p[1]) {
    return { action: 'setting.update', resourceType: 'setting', resourceId: decoded(p[1]) }
  }
  if (verb === 'POST' && p[0] === 'pricing' && p[1] === 'refresh') {
    return { action: 'pricing.refresh', resourceType: 'pricing', resourceId: null }
  }
  if (verb === 'POST' && p[0] === 'jobs' && p[1] && p[2] === 'cancel') {
    return { action: 'job.cancel', resourceType: 'job', resourceId: decoded(p[1]) }
  }
  if (verb === 'GET' && p[0] === 'audit-events') {
    return { action: 'audit.read', resourceType: 'audit_log', resourceId: null }
  }

  // These routes already record successful mutations with richer details.
  if (p[0] === 'users' && ['POST', 'PUT', 'PATCH'].includes(verb)) {
    return { action: 'user.manage', resourceType: 'user', resourceId: decoded(p[1]), dedicatedSuccessAudit: true }
  }
  if (p[0] === 'service-accounts' && ['POST', 'PATCH', 'DELETE'].includes(verb)) {
    return { action: 'service_account.manage', resourceType: 'service_account', resourceId: decoded(p[1]), dedicatedSuccessAudit: true }
  }
  return null
}

function requestMeta(c: Context) {
  const requestId = c.req.header('X-Request-Id')
  return {
    ipAddress: c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? null,
    userAgent: c.req.header('User-Agent') ?? null,
    requestId: requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
      ? requestId : null,
  }
}

export function auditActivity(audit: AuditWriter): MiddlewareHandler {
  return async (c, next) => {
    const activity = classifyActivity(c.req.method, c.req.path)
    if (!activity) return next()
    const principal = getSessionPrincipal(c)
    if (!principal) return next()

    let thrown = false
    try {
      await next()
    } catch (error) {
      thrown = true
      await audit.write({
        actor: { type: 'user', userId: principal.user.id },
        action: activity.action, outcome: 'failure',
        resourceType: activity.resourceType, resourceId: activity.resourceId,
        details: { method: c.req.method, status: 500 }, ...requestMeta(c),
      }).catch(auditError => console.error('audit write failed', auditError))
      throw error
    } finally {
      if (!thrown) {
        const status = c.res.status
        const outcome = status >= 200 && status < 400 ? 'success'
          : status === 401 || status === 403 ? 'denied' : 'failure'
        if (!(activity.dedicatedSuccessAudit && outcome === 'success')) {
          await audit.write({
            actor: { type: 'user', userId: principal.user.id },
            action: activity.action, outcome,
            resourceType: activity.resourceType, resourceId: activity.resourceId,
            details: { method: c.req.method, status }, ...requestMeta(c),
          }).catch(error => console.error('audit write failed', error))
        }
      }
    }
  }
}
