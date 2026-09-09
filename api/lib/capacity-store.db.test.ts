import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createCapacityStore } from './capacity-store.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const store = createCapacityStore(pools)
const CONNECTION_ID = 'captest001'

beforeAll(async () => {
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, access_key_id_enc, secret_access_key_enc, access_key_id_masked)
     VALUES ($1, 'capacity-store-test', 'http://example.invalid', 'x', 'x', 'x')
     ON CONFLICT (id) DO NOTHING`, [CONNECTION_ID],
  )
})
beforeEach(async () => {
  await pools.rw.query('DELETE FROM storage_capacity_snapshots WHERE connection_id = $1', [CONNECTION_ID])
  await pools.rw.query('DELETE FROM storage_capacity_targets WHERE connection_id = $1', [CONNECTION_ID])
  await pools.rw.query('DELETE FROM storage_capacity_settings WHERE connection_id = $1', [CONNECTION_ID])
  await pools.rw.query("DELETE FROM jobs WHERE kind = 'capacity.test'")
})
afterAll(async () => {
  await pools.rw.query('DELETE FROM storage_connections WHERE id = $1', [CONNECTION_ID])
  await closePools(pools)
})

describe('createCapacityStore', () => {
  it('未設定ではconnection追跡OFF・全bucketの履歴なしを返す', async () => {
    expect(await store.overview(CONNECTION_ID, ['archive', 'data'], 30)).toEqual({
      tracking: {
        enabled: false, intervalSeconds: 86400, nextRunAt: null,
        lastAttemptAt: null, lastStatus: 'paused', lastError: null, consecutiveFailures: 0,
      },
      buckets: [
        { bucket: 'archive', lastSuccessAt: null, lastStatus: null, lastError: null, points: [] },
        { bucket: 'data', lastSuccessAt: null, lastStatus: null, lastError: null, points: [] },
      ],
    })
  })

  it('全bucketをconnection設定へ同期する', async () => {
    await pools.rw.query(
      `INSERT INTO storage_capacity_settings
         (connection_id, enabled, interval_seconds, next_run_at, last_status)
       VALUES ($1, true, 43200, now(), 'waiting')`, [CONNECTION_ID])
    await store.syncBuckets(CONNECTION_ID, ['data', 'archive'])
    const rows = await pools.ro.query<{ bucket: string; enabled: boolean; interval_seconds: number }>(
      `SELECT bucket, enabled, interval_seconds FROM storage_capacity_targets
        WHERE connection_id = $1 ORDER BY bucket`, [CONNECTION_ID])
    expect(rows.rows).toEqual([
      { bucket: 'archive', enabled: true, interval_seconds: 43200 },
      { bucket: 'data', enabled: true, interval_seconds: 43200 },
    ])
  })

  it('完全走査をjob単位で一度だけ保存する', async () => {
    const job = await pools.rw.query<{ id: number }>(
      `INSERT INTO jobs (kind, dedup_key, payload, status)
       VALUES ('capacity.test', 'one', '{}', 'done') RETURNING id`,
    )
    await store.recordSuccess(job.rows[0].id, CONNECTION_ID, 'data', { totalBytes: 1234, objectCount: 7 })
    await store.recordSuccess(job.rows[0].id, CONNECTION_ID, 'data', { totalBytes: 9999, objectCount: 9 })
    const result = await store.overview(CONNECTION_ID, ['data'], 30)
    expect(result.buckets[0].points).toHaveLength(1)
    expect(result.buckets[0].points[0]).toMatchObject({ totalBytes: 1234, objectCount: 7 })
  })

  it('期限を迎えたconnectionを一度だけ予約する', async () => {
    await pools.rw.query(
      `INSERT INTO storage_capacity_settings
         (connection_id, enabled, interval_seconds, next_run_at, last_status)
       VALUES ($1, true, 86400, now(), 'waiting')`, [CONNECTION_ID])
    expect(await store.reserveDueConnections(20)).toEqual([CONNECTION_ID])
    expect(await store.reserveDueConnections(20)).toEqual([])
  })
})
