import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { MetricsCollector } from '../lib/metrics-collector.js'
import { mountMetricsRoutes } from './metrics.js'

const metricsKey = { scopes: ['metrics:read'] }
const lineageKey = { scopes: ['lineage:write'] }
const bearer = { Authorization: 'Bearer mado_lin_key.secret' }

const capacity: MetricsCollector = {
  name: 'capacity',
  collect: async () => [{
    name: 'mado_storage_bucket_bytes', help: 'Latest measured bucket size in bytes.', type: 'gauge',
    samples: [{ labels: { connection_id: 'connection-a', bucket: 'dataset' }, value: '10' }],
  }],
}

function appWith(collectors: MetricsCollector[], principal: { scopes: string[] } | null = metricsKey) {
  const app = new Hono()
  const log = { error: vi.fn() }
  mountMetricsRoutes(app, { authenticate: async () => principal, collectors, log })
  return { app, log }
}

describe('metrics route', () => {
  it('metrics:readのkeyに領域ごとのpathでPrometheus形式を返し、cacheさせない', async () => {
    const response = await appWith([capacity]).app.request('/metrics/capacity', { headers: bearer })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text())
      .toContain('mado_storage_bucket_bytes{connection_id="connection-a",bucket="dataset"} 10')
  })

  it('keyなしは401、lineage:writeだけのkeyは403で拒否する', async () => {
    expect((await appWith([capacity]).app.request('/metrics/capacity')).status).toBe(401)
    const denied = await appWith([capacity], lineageKey).app.request('/metrics/capacity', { headers: bearer })
    expect(denied.status).toBe(403)
  })

  it('領域の値を読めなかったら503を返し、他の領域には影響しない', async () => {
    const broken: MetricsCollector = { name: 'jobs', collect: async () => { throw new Error('db down') } }
    const { app, log } = appWith([capacity, broken])
    const failed = await app.request('/metrics/jobs', { headers: bearer })
    expect(failed.status).toBe(503)
    expect(await failed.text()).toBe('metrics unavailable')
    expect(log.error).toHaveBeenCalledOnce()
    expect((await app.request('/metrics/capacity', { headers: bearer })).status).toBe(200)
  })

  it('領域名のない/metricsと未登録の領域は提供しない', async () => {
    const { app } = appWith([capacity])
    expect((await app.request('/metrics', { headers: bearer })).status).toBe(404)
    expect((await app.request('/metrics/unknown', { headers: bearer })).status).toBe(404)
  })
})
