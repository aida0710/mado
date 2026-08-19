import { describe, expect, it } from 'vitest'
import { createJobRunner, type JobHandler } from './job-runner.js'
import type { JobProgress, JobStore } from './jobs.js'

// store の fake。実 DB は jobs.test.ts で検証済みなので、ここは
// ランナーの制御フローだけを見る。
function fakeStore(job: { id: number; kind: string; payload: unknown } | null) {
  const calls = {
    finish: [] as Array<[number, unknown]>,
    fail: [] as Array<[number, string]>,
    heartbeat: [] as Array<[number, JobProgress | null]>,
  }
  let canceled = false
  const store = {
    claim: async () => job,
    heartbeat: async (id: number, p: JobProgress | null) => { calls.heartbeat.push([id, p]) },
    finish: async (id: number, r: unknown) => { calls.finish.push([id, r]) },
    fail: async (id: number, m: string) => { calls.fail.push([id, m]) },
    isCanceled: async () => canceled,
  } as unknown as JobStore
  return { store, calls, setCanceled: (v: boolean) => { canceled = v } }
}

describe('createJobRunner', () => {
  it('queued が無ければ false を返す', async () => {
    const { store } = fakeStore(null)
    const runner = createJobRunner({ store, handlers: {} })
    expect(await runner.runOnce()).toBe(false)
  })

  it('ハンドラの戻り値が finish に渡る', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: { a: 1 } })
    const handler: JobHandler = async ctx => ({ echoed: ctx.payload })
    const runner = createJobRunner({ store, handlers: { k: handler } })
    expect(await runner.runOnce()).toBe(true)
    expect(calls.finish).toEqual([[1, { echoed: { a: 1 } }]])
  })

  it('ハンドラが throw したら fail にメッセージが渡る', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: {} })
    const handler: JobHandler = async () => { throw new Error('S3 が落ちています') }
    const runner = createJobRunner({ store, handlers: { k: handler } })
    await runner.runOnce()
    expect(calls.fail[0][1]).toBe('S3 が落ちています')
  })

  it('未登録の kind は fail にする', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'unknown.kind', payload: {} })
    const runner = createJobRunner({ store, handlers: {} })
    await runner.runOnce()
    expect(calls.fail[0][1]).toContain('unknown.kind')
  })

  // ハンドラは呼び放題でよく、間引きは基盤側で行う。
  it('setProgress は指定間隔に間引かれる', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: {} })
    let t = 0
    const handler: JobHandler = async ctx => {
      ctx.setProgress({ kind: 'count', done: 1 })
      t = 500
      ctx.setProgress({ kind: 'count', done: 2 })
      t = 2500
      ctx.setProgress({ kind: 'count', done: 3 })
      return null
    }
    const runner = createJobRunner({
      store, handlers: { k: handler }, now: () => t, progressIntervalMs: 2000,
    })
    await runner.runOnce()
    expect(calls.heartbeat.map(([, p]) => p)).toEqual([
      { kind: 'count', done: 1 },
      { kind: 'count', done: 3 },
    ])
  })

  it('canceled になったら signal が abort される', async () => {
    const { store, setCanceled } = fakeStore({ id: 1, kind: 'k', payload: {} })
    let aborted = false
    const handler: JobHandler = async ctx => {
      setCanceled(true)
      ctx.setProgress({ kind: 'count', done: 1 })
      await new Promise(r => setTimeout(r, 10))
      aborted = ctx.signal.aborted
      return null
    }
    let t = 0
    const runner = createJobRunner({
      store, handlers: { k: handler }, now: () => (t += 10_000),
      progressIntervalMs: 0, cancelCheckIntervalMs: 0,
    })
    await runner.runOnce()
    expect(aborted).toBe(true)
  })
})
