import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AuditWriter } from './audit.js'
import { auditActivity, classifyActivity, markAuditChangeCommitted, markAuditNoChange } from './audit-activity.js'
import { setSessionPrincipal } from './rbac.js'

const user = {
  id: '00000000-0000-4000-8000-000000000001', username: 'u', email: null,
  displayName: 'User', signatureName: '署名', status: 'active' as const,
  roles: ['admin'], permissions: ['storage:read'], mustChangePassword: false,
}

describe('監査の記録判定', () => {
  it('主要な変更だけを分類する', () => {
    expect(classifyActivity('PUT', '/api/internal/notes/home')).toMatchObject({ action: 'note.update', resourceId: 'home' })
    expect(classifyActivity('DELETE', '/api/internal/storage/c1/favorites/bucket')).toMatchObject({ action: 'storage.favorite.remove' })
    expect(classifyActivity('GET', '/api/internal/storage/c1/preview/raw')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/notes/home')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/storage/c1/readme')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/lineage/datasets/d1')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/storage/c1/list')).toBeNull()
    expect(classifyActivity('GET', '/api/internal/storage/c1/capacity')).toBeNull()
    expect(classifyActivity('POST', '/api/internal/storage/c1/capacity/scan')).toMatchObject({
      action: 'storage.capacity.scan.start', resourceId: 'c1',
    })
    expect(classifyActivity('GET', '/api/internal/audit-events')).toBeNull()
    expect(classifyActivity('POST', '/api/internal/lineage/curation/datasets')).toMatchObject({
      action: 'lineage.dataset.register', dedicatedSuccessAudit: true,
    })
    expect(classifyActivity('PATCH', '/api/internal/lineage/curation/datasets/d1')).toMatchObject({
      action: 'lineage.dataset.update', resourceId: 'd1', dedicatedSuccessAudit: true,
    })
  })

  it('拒否された変更はintentを破棄する', async () => {
    const start = vi.fn().mockResolvedValue(42)
    const finish = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    const discard = vi.fn().mockResolvedValue(undefined)
    app.use('*', auditActivity({ start, finish, discard, write: vi.fn() } as unknown as AuditWriter))
    app.put('/settings/:key', c => c.json({ error: 'forbidden' }, 403))
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(403)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'user', userId: user.id }, action: 'setting.update', resourceId: 'theme',
    }))
    expect(finish).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledWith(42)
  })

  it('実変更が成功した通常routeはintentを成功として完了する', async () => {
    const start = vi.fn().mockResolvedValue(45)
    const finish = vi.fn().mockResolvedValue(undefined)
    const discard = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ start, finish, discard, write: vi.fn() } as unknown as AuditWriter))
    app.put('/settings/:key', c => c.json({ ok: true }))
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(200)
    expect(finish).toHaveBeenCalledWith(45, 'success', expect.objectContaining({ status: 200 }))
    expect(discard).not.toHaveBeenCalled()
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

  it('成功応答でも実変更なしならintentを破棄する', async () => {
    const start = vi.fn().mockResolvedValue(44)
    const finish = vi.fn().mockResolvedValue(undefined)
    const discard = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({ start, finish, discard, write: vi.fn() } as unknown as AuditWriter))
    app.put('/settings/:key', c => {
      markAuditNoChange(c)
      return c.json({ ok: true })
    })
    expect((await app.request('/settings/theme', { method: 'PUT' })).status).toBe(200)
    expect(finish).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledWith(44)
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

  it('commit後の専用audit失敗ではintentを破棄せず成功へ確定する', async () => {
    const finish = vi.fn().mockResolvedValue(undefined)
    const discard = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 's', user })
      await next()
    })
    app.use('*', auditActivity({
      start: vi.fn().mockResolvedValue(46), finish, discard, write: vi.fn(),
    } as unknown as AuditWriter))
    app.patch('/users/:id', c => {
      markAuditChangeCommitted(c)
      throw new Error('rich audit unavailable')
    })
    expect((await app.request('/users/u1', { method: 'PATCH' })).status).toBe(500)
    expect(finish).toHaveBeenCalledWith(46, 'success', expect.objectContaining({
      state: 'committed', completionInterrupted: true,
    }))
    expect(discard).not.toHaveBeenCalled()
  })
})
