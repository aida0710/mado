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

describe('claim / 完了', () => {
  it('queued を 1 件 claim して running にする', async () => {
    const id = await store.enqueue('k', 'd', { a: 1 })
    const job = await store.claim()
    expect(job).toMatchObject({ id, kind: 'k' })
    expect(job!.payload).toEqual({ a: 1 })
    const after = await store.get(id)
    expect(after!.status).toBe('running')
    expect(after!.attempts).toBe(1)
  })

  it('queued が無ければ null', async () => {
    expect(await store.claim()).toBeNull()
  })

  it('同じジョブを二重に claim しない', async () => {
    await store.enqueue('k', 'd', {})
    expect(await store.claim()).not.toBeNull()
    expect(await store.claim()).toBeNull()
  })

  it('古い queued から順に取る', async () => {
    const first = await store.enqueue('k', 'd1', {})
    await pools.rw.query(`UPDATE jobs SET created_at = now() - interval '1 hour' WHERE id=$1`, [first])
    await store.enqueue('k', 'd2', {})
    expect((await store.claim())!.id).toBe(first)
  })

  it('finish で done と result が入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.finish(id, { total: 42 })
    const job = await store.get(id)
    expect(job!.status).toBe('done')
    expect(job!.result).toEqual({ total: 42 })
    expect(job!.finishedAt).not.toBeNull()
  })

  it('fail で error とメッセージが入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.fail(id, 'S3 が落ちています')
    const job = await store.get(id)
    expect(job!.status).toBe('error')
    expect(job!.error).toBe('S3 が落ちています')
  })

  it('heartbeat で進捗が入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.heartbeat(id, { kind: 'count', done: 1200 })
    expect((await store.get(id))!.progress).toEqual({ kind: 'count', done: 1200 })
  })
})

describe('キャンセル', () => {
  it('cancel で canceled になり isCanceled が true', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    expect(await store.isCanceled(id)).toBe(false)
    await store.cancel(id)
    expect((await store.get(id))!.status).toBe('canceled')
    expect(await store.isCanceled(id)).toBe(true)
  })

  it('done のジョブは cancel しても done のまま', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.finish(id, {})
    await store.cancel(id)
    expect((await store.get(id))!.status).toBe('done')
  })
})

describe('requeueStale', () => {
  it('heartbeat が途絶えた running を queued に戻す', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await pools.rw.query(`UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id=$1`, [id])
    expect(await store.requeueStale(120, 3)).toBe(1)
    expect((await store.get(id))!.status).toBe('queued')
  })

  it('heartbeat が新しければ戻さない', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    expect(await store.requeueStale(120, 3)).toBe(0)
    expect((await store.get(id))!.status).toBe('running')
  })

  it('attempts が上限に達したら error にする', async () => {
    const id = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='running', attempts=3, heartbeat_at=now() - interval '10 minutes' WHERE id=$1`, [id])
    expect(await store.requeueStale(120, 3)).toBe(1)
    const job = await store.get(id)
    expect(job!.status).toBe('error')
    expect(job!.error).toContain('繰り返し')
  })
})
