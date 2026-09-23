import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  createCapacityMetricsApp, loadCapacityMetricRows, renderCapacityMetrics,
  type CapacityMetricRow,
} from './capacity-metrics.js'

const latest: CapacityMetricRow = {
  connection_id: 'connection-a', bucket: 'dataset', consecutive_failures: 2,
  total_bytes: '9007199254740993', object_count: '547259',
  collected_at: new Date('2026-09-23T00:00:00Z'),
}

describe('capacity Prometheus metrics', () => {
  it('queries the latest saved snapshot for each target through the supplied pool', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [latest] })
    expect(await loadCapacityMetricRows({ query } as unknown as Pool)).toEqual([latest])
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0]).toContain('ORDER BY collected_at DESC, id DESC LIMIT 1')
  })

  it('renders measured values, age, failures, and escapes labels', () => {
    const body = renderCapacityMetrics([
      latest,
      { ...latest, bucket: 'new"\\\nbucket', total_bytes: null, object_count: null,
        collected_at: null, consecutive_failures: 1 },
    ], new Date('2026-09-23T00:01:00Z'))
    expect(body).toContain('mado_storage_bucket_bytes{connection_id="connection-a",bucket="dataset"} 9007199254740993')
    expect(body).toContain('mado_storage_bucket_objects{connection_id="connection-a",bucket="dataset"} 547259')
    expect(body).toContain('mado_storage_capacity_collection_age_seconds{connection_id="connection-a",bucket="dataset"} 60')
    expect(body).toContain('mado_storage_capacity_collection_failures{connection_id="connection-a",bucket="dataset"} 2')
    expect(body).toContain('bucket="new\\"\\\\\\nbucket"} 1')
    expect(body.match(/mado_storage_bucket_bytes\{/g)).toHaveLength(1)
    expect(body.endsWith('\n')).toBe(true)
  })

  it('serves only /metrics and returns 503 when the database fails', async () => {
    const app = createCapacityMetricsApp(async () => [latest])
    const response = await app.request('/metrics')
    expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await app.request('/healthz')).status).toBe(404)

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failed = await createCapacityMetricsApp(async () => { throw new Error('db down') }).request('/metrics')
      expect(failed.status).toBe(503)
      expect(await failed.text()).toBe('metrics unavailable')
    } finally {
      error.mockRestore()
    }
  })
})
