import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { JobStore } from '../lib/jobs.js'
import { mountJobRoutes } from './jobs.js'

function job(id: number, connId = 'restricted1') {
  return {
    id,
    kind: 'storage.scan',
    dedupKey: 'key',
    status: 'queued' as const,
    attempts: 0,
    payload: { connId },
    progress: null,
    result: null,
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
    cancelRequested: false,
  }
}

function fixture(canAccess: boolean) {
  const row = job(7)
  const store = {
    activeOrLatest: vi.fn().mockResolvedValue(row),
    get: vi.fn().mockResolvedValue(row),
    cancel: vi.fn().mockResolvedValue(true),
  } as unknown as JobStore
  const app = new Hono()
  mountJobRoutes(app, {
    store,
    canAccessConnection: vi.fn().mockResolvedValue(canAccess),
  })
  return { app, store }
}

describe('job routeの接続ホワイトリスト', () => {
  it('非許可のjobはlatestとID参照の両方で404にする', async () => {
    const { app } = fixture(false)
    expect((await app.request('/jobs/latest?kind=storage.scan&dedupKey=key')).status).toBe(404)
    expect((await app.request('/jobs/7')).status).toBe(404)
  })

  it('非許可のjobはキャンセルできない', async () => {
    const { app, store } = fixture(false)
    expect((await app.request('/jobs/7/cancel', { method: 'POST' })).status).toBe(404)
    expect(store.cancel).not.toHaveBeenCalled()
  })

  it('許可されたjobは従来どおり参照できる', async () => {
    const { app } = fixture(true)
    const res = await app.request('/jobs/7')
    expect(res.status).toBe(200)
    expect((await res.json() as { id: number }).id).toBe(7)
  })
})
