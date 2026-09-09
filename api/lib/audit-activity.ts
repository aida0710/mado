import type { Context, MiddlewareHandler } from 'hono'
import type { AuditWriter } from './audit.js'
import { getSessionPrincipal } from './rbac.js'
import { requestMetadata } from './request-metadata.js'

interface Activity {
  action: string
  resourceType: string
  resourceId: string | null
  /** Route自身がsuccess auditを書く場合、共通middlewareは失敗・拒否だけ補完する。 */
  dedicatedSuccessAudit?: boolean
}

const AUDIT_CHANGED_KEY = 'madoAuditChanged'
const AUDIT_COMMITTED_KEY = 'madoAuditCommitted'

/** 成功応答でも永続状態が変わらなかったことを共通監査へ伝える。 */
export function markAuditNoChange(c: Context): void {
  c.set(AUDIT_CHANGED_KEY, false)
}

/** 専用監査routeでdomain変更がcommit済みであることを示す。後続処理が失敗しても
 *  durable intentを捨てず、最低限の成功記録へ確定するために使う。 */
export function markAuditChangeCommitted(c: Context): void {
  c.set(AUDIT_COMMITTED_KEY, true)
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
    if (verb === 'PUT' && p[2] === 'capacity' && p[3] === 'tracking') {
      return { action: 'storage.capacity.tracking.update', resourceType: 'connection', resourceId: connectionId }
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
  if (p[0] === 'lineage' && p[1] === 'curation') {
    if (verb === 'PATCH' && p[2] === 'datasets' && p[3]) return {
      action: 'lineage.dataset.update', resourceType: 'dataset', resourceId: decoded(p[3]),
      dedicatedSuccessAudit: true,
    }
    if (verb !== 'POST') return null
    const kind = p[2] === 'datasets' ? 'dataset' : p[2] === 'locations' ? 'location'
      : p[2] === 'runs' ? 'run' : null
    if (kind) return {
      action: `lineage.${kind}.register`, resourceType: kind, resourceId: null,
      dedicatedSuccessAudit: true,
    }
  }
  // These routes already record successful mutations with richer details.
  if (p[0] === 'users' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) {
    return { action: 'user.manage', resourceType: 'user', resourceId: decoded(p[1]), dedicatedSuccessAudit: true }
  }
  if (p[0] === 'service-accounts' && ['POST', 'PATCH', 'DELETE'].includes(verb)) {
    return { action: 'service_account.manage', resourceType: 'service_account', resourceId: decoded(p[1]), dedicatedSuccessAudit: true }
  }
  if (verb === 'PUT' && p[0] === 'profile') {
    return { action: 'auth.profile.update', resourceType: 'user', resourceId: null, dedicatedSuccessAudit: true }
  }
  if (verb === 'POST' && p[0] === 'change-password') {
    return { action: 'auth.password.change', resourceType: 'user', resourceId: null, dedicatedSuccessAudit: true }
  }
  return null
}

export function auditActivity(audit: AuditWriter): MiddlewareHandler {
  return async (c, next) => {
    const activity = classifyActivity(c.req.method, c.req.path)
    if (!activity) return next()
    const principal = getSessionPrincipal(c)
    if (!principal) return next()

    const metadata = requestMetadata(c)
    const intentId = await audit.start({
      actor: { type: 'user', userId: principal.user.id },
      action: activity.action,
      resourceType: activity.resourceType,
      resourceId: activity.resourceId,
      details: { method: c.req.method, state: 'started' },
      ...metadata,
    })

    try {
      await next()
    } catch (error) {
      if (c.get(AUDIT_COMMITTED_KEY) === true) {
        await audit.finish(intentId, 'success', {
          method: c.req.method, state: 'committed', completionInterrupted: true,
        }).catch(auditError => console.error('committed audit intent completion failed', auditError))
      } else {
        await audit.discard(intentId).catch(auditError => console.error('audit intent discard failed', auditError))
      }
      throw error
    }

    const status = c.res.status
    const outcome = status >= 200 && status < 400 ? 'success'
      : status === 401 || status === 403 ? 'denied' : 'failure'
    const changed = c.get(AUDIT_CHANGED_KEY) !== false
    if (c.get(AUDIT_COMMITTED_KEY) === true && outcome !== 'success') {
      await audit.finish(intentId, 'success', {
        method: c.req.method, status, state: 'committed', completionInterrupted: true,
      }).catch(error => console.error('committed audit intent completion failed', error))
    } else if (outcome !== 'success' || !changed || activity.dedicatedSuccessAudit) {
      await audit.discard(intentId).catch(error => console.error('audit intent discard failed', error))
    } else {
      await audit.finish(intentId, outcome, {
        method: c.req.method, status, state: 'completed',
      }).catch(error => console.error('audit intent completion failed', error))
    }
  }
}
