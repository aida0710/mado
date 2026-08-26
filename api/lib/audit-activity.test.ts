import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AuditWriter } from './audit.js'
import { auditActivity, classifyActivity } from './audit-activity.js'
import { setSessionPrincipal } from './rbac.js'

const user = {
  id: '00000000-0000-4000-8000-000000000001', username: 'u', email: null,
  displayName: 'User', signatureName: '署名', status: 'active' as const,
  roles: ['admin'], permissions: ['storage:read'], mustChangePassword: false,
}

describe('audit activity', () => {
  it('主要な変更とdownloadを分類する', () => {
    expect(classifyActivity('PUT', '/api/internal/notes/home')).toMatchObject({ action: 'note.update', resourceId: 'home' })
    expect(classifyActivity('DELETE', '/api/internal/storage/c1/favorites/bucket')).toMatchObject({ action: 'storage.favorite.remove' })
    expect(classifyActivity('GET', '/api/internal/storage/c1/preview/raw')).toMatchObject({ action: 'storage.download.raw' })
    expect(classifyActivity('GET', '/api/internal/storage/c1/list')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/audit-events')).toBeNull()
    expect(classifyActivity('POST', '/api/internal/lineage/curation/datasets')).toMatchObject({
      action: 'lineage.dataset.register', dedicatedSuccessAudit: true,
    })
  })

  it('response outcomeとactorを記録する', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ write } as AuditWriter))
    app.put('/settings/:key', c => c.json({ error: 'forbidden' }, 403))
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(403)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'user', userId: user.id }, action: 'setting.update', outcome: 'denied',
      resourceId: 'theme', details: { method: 'PUT', status: 403 },
    }))
  })

  it('専用auditがあるrouteでは成功を重複記録しない', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ write } as AuditWriter))
    app.post('/users', c => c.json({ ok: true }, 201))
    await app.request('/users', { method: 'POST' })
    expect(write).not.toHaveBeenCalled()
  })
})
