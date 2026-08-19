import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createJobStore } from './jobs.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const store = createJobStore(pools)

beforeEach(() => pools.rw.query('TRUNCATE jobs'))
afterAll(() => closePools(pools))

describe('enqueue / get', () => {
  it('投入した内容を id で引き戻せる', async () => {
    const id = await store.enqueue('storage.scan', 'c1\nb\np/', { connId: 'c1' })
    const job = await store.get(id)
    expect(job).toMatchObject({
      id, kind: 'storage.scan', dedupKey: 'c1\nb\np/', status: 'queued', attempts: 0,
    })
    expect(job!.payload).toEqual({ connId: 'c1' })
  })

  it('存在しない id は null', async () => {
    expect(await store.get(999999)).toBeNull()
  })

  it('実行中の同一対象を再投入すると既存の id が返る', async () => {
    const a = await store.enqueue('storage.scan', 'same', {})
    const b = await store.enqueue('storage.scan', 'same', {})
    expect(b).toBe(a)
    const n = await pools.rw.query<{ c: number }>('SELECT count(*)::int AS c FROM jobs')
    expect(n.rows[0].c).toBe(1)
  })

  it('kind が違えば別ジョブになる', async () => {
    const a = await store.enqueue('storage.scan', 'same', {})
    const b = await store.enqueue('other.kind', 'same', {})
    expect(b).not.toBe(a)
  })

  it('latestDone は最後に成功したジョブを返す', async () => {
    const old = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', result='{"n":1}', finished_at=now() - interval '1 hour' WHERE id=$1`, [old])
    const recent = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', result='{"n":2}', finished_at=now() WHERE id=$1`, [recent])

    const job = await store.latestDone('storage.scan', 'k')
    expect(job!.id).toBe(recent)
    expect(job!.result).toEqual({ n: 2 })
  })

  it('latestDone は done 以外を拾わない', async () => {
    const id = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(`UPDATE jobs SET status='error', finished_at=now() WHERE id=$1`, [id])
    expect(await store.latestDone('storage.scan', 'k')).toBeNull()
  })
})
