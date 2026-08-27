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
    const start = vi.fn().mockResolvedValue(42)
    const finish = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ start, finish, discard: vi.fn(), write: vi.fn() } as unknown as AuditWriter))
    app.put('/settings/:key', c => c.json({ error: 'forbidden' }, 403))
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(403)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'user', userId: user.id }, action: 'setting.update', resourceId: 'theme',
    }))
    expect(finish).toHaveBeenCalledWith(42, 'denied', {
      method: 'PUT', status: 403, state: 'completed',
    })
  })

  it('専用auditがあるrouteでは成功を重複記録しない', async () => {
    const start = vi.fn().mockResolvedValue(43)
    const discard = vi.fn().mockResolvedValue(undefined)
    const write = vi.fn()
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ start, finish: vi.fn(), discard, write } as unknown as AuditWriter))
    app.post('/users', c => c.json({ ok: true }, 201))
    await app.request('/users', { method: 'POST' })
    expect(write).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledWith(43)
  })

  it('audit intentを保存できなければmutationを実行しない', async () => {
    const app = new Hono()
    const mutation = vi.fn(c => c.json({ ok: true }))
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({
      start: vi.fn().mockRejectedValue(new Error('audit unavailable')),
      finish: vi.fn(), discard: vi.fn(), write: vi.fn(),
    } as unknown as AuditWriter))
    app.put('/settings/:key', mutation)
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(500)
    expect(mutation).not.toHaveBeenCalled()
  })
})
