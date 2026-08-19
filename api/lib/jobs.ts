import type { Pools } from '../db.js'

// 汎用ジョブキューの永続化層 (spec: 2026-08-18-job-queue-design.md)。
// ループとハンドラ実行は job-runner.ts が持ち、ここは SQL だけに閉じる。

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

/** 進捗。総数が分からない処理があるので、パーセンテージを強制しない。
 *  S3 には件数を返す API が無く、初回の走査では分母が原理的に出せない。 */
export type JobProgress =
  | { kind: 'count'; done: number; label?: string }
  | { kind: 'ratio'; done: number; total: number; label?: string }

export interface JobRow {
  id: number
  kind: string
  dedupKey: string
  payload: unknown
  status: JobStatus
  progress: JobProgress | null
  result: unknown
  error: string | null
  attempts: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface DbJobRow {
  id: number
  kind: string
  dedup_key: string
  payload: unknown
  status: JobStatus
  progress: JobProgress | null
  result: unknown
  error: string | null
  attempts: number
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const COLUMNS = `id, kind, dedup_key, payload, status, progress, result, error,
                 attempts, created_at, started_at, finished_at`

function toRow(r: DbJobRow): JobRow {
  return {
    id: r.id,
    kind: r.kind,
    dedupKey: r.dedup_key,
    payload: r.payload,
    status: r.status,
    progress: r.progress,
    result: r.result,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  }
}

export interface JobStore {
  enqueue(kind: string, dedupKey: string, payload: unknown): Promise<number>
  get(id: number): Promise<JobRow | null>
  latestDone(kind: string, dedupKey: string): Promise<JobRow | null>
  /** 実行中 (queued/running) があればそれを、無ければ最後に成功したジョブを返す。
   *  リロードで jobId を失った UI が実行中のジョブへ再接続するために使う。 */
  activeOrLatest(kind: string, dedupKey: string): Promise<JobRow | null>
  /** queued を 1 件 running にして返す。無ければ null。 */
  claim(): Promise<{ id: number; kind: string; payload: unknown } | null>
  heartbeat(id: number, progress: JobProgress | null): Promise<void>
  finish(id: number, result: unknown): Promise<void>
  fail(id: number, message: string): Promise<void>
  cancel(id: number): Promise<void>
  isCanceled(id: number): Promise<boolean>
  /** heartbeat の途絶えた running を queued に戻す。上限到達分は error にする。
   *  戻り値は処理した件数。 */
  requeueStale(staleAfterSec: number, maxAttempts: number): Promise<number>
  /** 完了ジョブの掃除。(kind, dedup_key) ごとの最新 done は結果ストアを
   *  兼ねるので残し、それより古い完了行だけを消す。戻り値は削除件数。 */
  pruneFinished(keepDays: number): Promise<number>
}

export function createJobStore(pools: Pools): JobStore {
  return {
    /** 実行中の同一対象があれば新規作成せずその id を返す (部分一意インデックスで合流)。 */
    async enqueue(kind, dedupKey, payload) {
      const r = await pools.rw.query<{ id: number }>(
        `INSERT INTO jobs (kind, dedup_key, payload) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [kind, dedupKey, JSON.stringify(payload)],
      )
      if (r.rows[0]) return r.rows[0].id

      // 競合 = 実行中の同一対象が既にある。その id を返す。
      const existing = await pools.rw.query<{ id: number }>(
        `SELECT id FROM jobs
          WHERE kind = $1 AND dedup_key = $2 AND status IN ('queued','running')`,
        [kind, dedupKey],
      )
      return existing.rows[0].id
    },

    async get(id) {
      const r = await pools.ro.query<DbJobRow>(
        `SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id])
      return r.rows[0] ? toRow(r.rows[0]) : null
    },

    async latestDone(kind, dedupKey) {
      const r = await pools.ro.query<DbJobRow>(
        `SELECT ${COLUMNS} FROM jobs
          WHERE kind = $1 AND dedup_key = $2 AND status = 'done'
          ORDER BY finished_at DESC LIMIT 1`,
        [kind, dedupKey],
      )
      return r.rows[0] ? toRow(r.rows[0]) : null
    },

    async activeOrLatest(kind, dedupKey) {
      // 実行中を優先する。error / canceled は拾わない — それらを「最新」と
      // して返すと、その前に取れていた成功結果が見えなくなるため。
      const r = await pools.ro.query<DbJobRow>(
        `SELECT ${COLUMNS} FROM jobs
          WHERE kind = $1 AND dedup_key = $2
            AND status IN ('queued','running','done')
          ORDER BY (status IN ('queued','running')) DESC, finished_at DESC NULLS LAST
          LIMIT 1`,
        [kind, dedupKey],
      )
      return r.rows[0] ? toRow(r.rows[0]) : null
    },

    // SKIP LOCKED なので、将来 worker を増やしても取り合いにならない。
    async claim() {
      const r = await pools.rw.query<{ id: number; kind: string; payload: unknown }>(
        `UPDATE jobs SET status = 'running', started_at = now(), heartbeat_at = now(),
                         attempts = attempts + 1
          WHERE id = (
            SELECT id FROM jobs WHERE status = 'queued'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING id, kind, payload`,
      )
      return r.rows[0] ?? null
    },

    async heartbeat(id, progress) {
      await pools.rw.query(
        `UPDATE jobs SET heartbeat_at = now(), progress = COALESCE($2::jsonb, progress)
          WHERE id = $1 AND status = 'running'`,
        [id, progress === null ? null : JSON.stringify(progress)],
      )
    },

    async finish(id, result) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'done', result = $2, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(result)],
      )
    },

    async fail(id, message) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'error', error = $2, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, message],
      )
    },

    // 終端状態のジョブは触らない (done を canceled に落とさない)。
    async cancel(id) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'canceled', finished_at = now()
          WHERE id = $1 AND status IN ('queued','running')`,
        [id],
      )
    },

    async isCanceled(id) {
      const r = await pools.ro.query<{ status: JobStatus }>(
        'SELECT status FROM jobs WHERE id = $1', [id])
      return r.rows[0]?.status === 'canceled'
    },

    async requeueStale(staleAfterSec, maxAttempts) {
      const back = await pools.rw.query(
        `UPDATE jobs SET status = 'queued', started_at = NULL, heartbeat_at = NULL
          WHERE status = 'running'
            AND heartbeat_at < now() - make_interval(secs => $1)
            AND attempts < $2`,
        [staleAfterSec, maxAttempts],
      )
      const dead = await pools.rw.query(
        `UPDATE jobs SET status = 'error', finished_at = now(),
                         error = 'worker が繰り返し停止しました'
          WHERE status = 'running'
            AND heartbeat_at < now() - make_interval(secs => $1)
            AND attempts >= $2`,
        [staleAfterSec, maxAttempts],
      )
      return (back.rowCount ?? 0) + (dead.rowCount ?? 0)
    },

    async pruneFinished(keepDays) {
      const r = await pools.rw.query(
        `DELETE FROM jobs j
          WHERE j.status IN ('done','error','canceled')
            AND j.finished_at < now() - make_interval(days => $1)
            AND EXISTS (
              SELECT 1 FROM jobs n
               WHERE n.kind = j.kind AND n.dedup_key = j.dedup_key
                 AND n.status = 'done' AND n.finished_at > j.finished_at
            )`,
        [keepDays],
      )
      return r.rowCount ?? 0
    },
  }
}
