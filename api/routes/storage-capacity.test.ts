import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountStorageCapacityRoutes } from './storage-capacity.js'
import type { CapacityStore } from '../lib/capacity-store.js'
import type { ConnectionConfig } from '../storage.js'

const history = vi.fn()
const setTracking = vi.fn()
let scanEnabled = true
const store = { history, setTracking } as unknown as CapacityStore
const app = new Hono()
mountStorageCapacityRoutes(app, {
  store,
  getConnectionConfig: async () => ({ scanEnabled } as ConnectionConfig),
})

beforeEach(() => {
  history.mockReset().mockResolvedValue({ tracking: { enabled: false }, points: [] })
  setTracking.mockReset().mockResolvedValue({ changed: true, tracking: { enabled: true } })
  scanEnabled = true
})

describe('storage capacity routes', () => {
  it('指定期間の履歴を返す', async () => {
    const response = await app.request('/storage/c1/capacity?bucket=data&days=90')
    expect(response.status).toBe(200)
    expect(history).toHaveBeenCalledWith('c1', 'data', 90)
    expect(await response.json()).toMatchObject({ connectionId: 'c1', bucket: 'data', days: 90 })
  })

  it('未対応期間を拒否する', async () => {
    expect((await app.request('/storage/c1/capacity?bucket=data&days=31')).status).toBe(400)
  })

  it('追跡設定を保存する', async () => {
    const response = await app.request('/storage/c1/capacity/tracking?bucket=data', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalSeconds: 86400 }),
    })
    expect(response.status).toBe(200)
    expect(setTracking).toHaveBeenCalledWith('c1', 'data', true, 86400, null)
  })

  it('走査無効接続では追跡を開始しない', async () => {
    scanEnabled = false
    const response = await app.request('/storage/c1/capacity/tracking?bucket=data', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalSeconds: 86400 }),
    })
    expect(response.status).toBe(409)
    expect(setTracking).not.toHaveBeenCalled()
  })
})
