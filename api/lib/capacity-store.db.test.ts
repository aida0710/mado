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
  await pools.rw.query("DELETE FROM jobs WHERE kind = 'capacity.test'")
})
afterAll(async () => {
  await pools.rw.query('DELETE FROM storage_connections WHERE id = $1', [CONNECTION_ID])
  await closePools(pools)
})

describe('createCapacityStore', () => {
  it('未設定では追跡OFF・履歴なしを返す', async () => {
    expect(await store.history(CONNECTION_ID, 'data', 30)).toEqual({
      tracking: {
        enabled: false, intervalSeconds: 86400, nextRunAt: null,
        lastAttemptAt: null, lastSuccessAt: null, lastStatus: null, lastError: null,
        consecutiveFailures: 0,
      },
      points: [],
    })
  })

  it('同じ追跡設定の再保存を変更なしとして返す', async () => {
    expect((await store.setTracking(CONNECTION_ID, 'data', true, 86400, null)).changed).toBe(true)
    expect((await store.setTracking(CONNECTION_ID, 'data', true, 86400, null)).changed).toBe(false)
    expect((await store.setTracking(CONNECTION_ID, 'data', true, 43200, null)).changed).toBe(true)
    expect((await store.setTracking(CONNECTION_ID, 'data', false, 43200, null)).tracking.lastStatus).toBe('paused')
  })

  it('完全走査をjob単位で一度だけ保存する', async () => {
    const job = await pools.rw.query<{ id: number }>(
      `INSERT INTO jobs (kind, dedup_key, payload, status)
       VALUES ('capacity.test', 'one', '{}', 'done') RETURNING id`,
    )
    await store.recordSuccess(job.rows[0].id, CONNECTION_ID, 'data', { totalBytes: 1234, objectCount: 7 })
    await store.recordSuccess(job.rows[0].id, CONNECTION_ID, 'data', { totalBytes: 9999, objectCount: 9 })
    const result = await store.history(CONNECTION_ID, 'data', 30)
    expect(result.points).toHaveLength(1)
    expect(result.points[0]).toMatchObject({ totalBytes: 1234, objectCount: 7 })
  })

  it('期限を迎えた追跡対象を一度だけ予約する', async () => {
    await store.setTracking(CONNECTION_ID, 'data', true, 86400, null)
    expect(await store.reserveDue(20)).toEqual([{ connectionId: CONNECTION_ID, bucket: 'data' }])
    expect(await store.reserveDue(20)).toEqual([])
  })
})
