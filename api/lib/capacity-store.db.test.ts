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
  await pools.rw.query("DELETE FROM jobs WHERE kind = 'storage.scan' AND payload->>'connId' = $1", [CONNECTION_ID])
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
      scan: { jobs: [] },
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

  it('進行中の走査と進捗を返し、再投入時に古いerrorを消す', async () => {
    await pools.rw.query(
      `INSERT INTO storage_capacity_targets
         (connection_id, bucket, enabled, interval_seconds, next_run_at, last_status, last_error)
       VALUES ($1, 'archive', true, 86400, now(), 'partial', 'old error')`, [CONNECTION_ID])
    const job = await pools.rw.query<{ id: number }>(
      `INSERT INTO jobs
         (kind, dedup_key, payload, status, progress, started_at, heartbeat_at)
       VALUES ('storage.scan', 'capacity-active', $1, 'running', $2, now(), now())
       RETURNING id`,
      [JSON.stringify({ connId: CONNECTION_ID, bucket: 'archive', prefix: '' }),
        JSON.stringify({ kind: 'count', done: 1234, label: '件を走査' })],
    )

    await store.attachJob(CONNECTION_ID, 'archive', job.rows[0].id)
    const activity = await store.scanActivity(CONNECTION_ID)
    expect(activity.jobs).toHaveLength(1)
    expect(activity.jobs[0]).toMatchObject({
      jobId: job.rows[0].id, bucket: 'archive', status: 'running', objectCount: 1234,
    })
    const target = await pools.ro.query<{ last_status: string; last_error: string | null }>(
      `SELECT last_status, last_error FROM storage_capacity_targets
        WHERE connection_id = $1 AND bucket = 'archive'`, [CONNECTION_ID])
    expect(target.rows[0]).toEqual({ last_status: 'queued', last_error: null })
  })
})
