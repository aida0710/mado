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
  }
}
