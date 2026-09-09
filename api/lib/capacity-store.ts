import type { Pools } from '../db.js'
import type { ScanResult } from './scan.js'

export const CAPACITY_INTERVALS = [21600, 43200, 86400, 259200, 604800] as const
export type CapacityStatus = 'waiting' | 'queued' | 'success' | 'partial' | 'error' | 'paused'

export interface CapacityTarget {
  enabled: boolean
  intervalSeconds: number
  nextRunAt: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastStatus: CapacityStatus | null
  lastError: string | null
  consecutiveFailures: number
}

export interface CapacityPoint {
  totalBytes: number
  objectCount: number
  collectedAt: string
}

interface TargetRow {
  connection_id: string
  bucket: string
  enabled: boolean
  interval_seconds: number
  next_run_at: Date | null
  last_attempt_at: Date | null
  last_success_at: Date | null
  last_status: CapacityStatus | null
  last_error: string | null
  consecutive_failures: number
}

const safeNumber = (value: string | number): number => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('capacity value exceeds safe integer range')
  return n
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

function publicError(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name) : ''
  if (name === 'NoSuchBucket') return 'バケットが見つかりません'
  if (name === 'AccessDenied' || name === 'Forbidden') return 'バケットを走査する権限がありません'
  if (name === 'TimeoutError' || name === 'NetworkingError') return 'ストレージへの接続がタイムアウトしました'
  return '容量の取得に失敗しました'
}

export interface CapacityStore {
  history(connectionId: string, bucket: string, days: number): Promise<{ tracking: CapacityTarget; points: CapacityPoint[] }>
  setTracking(connectionId: string, bucket: string, enabled: boolean, intervalSeconds: number, userId: string | null): Promise<{ changed: boolean; tracking: CapacityTarget }>
  reserveDue(limit: number): Promise<Array<{ connectionId: string; bucket: string }>>
  attachJob(connectionId: string, bucket: string, jobId: number): Promise<void>
  markPaused(connectionId: string, bucket: string): Promise<void>
  recordSuccess(jobId: number, connectionId: string, bucket: string, result: Pick<ScanResult, 'totalBytes' | 'objectCount'>): Promise<void>
  recordPartial(connectionId: string, bucket: string): Promise<void>
  recordError(connectionId: string, bucket: string, error: unknown): Promise<void>
  prune(keepDays: number): Promise<number>
}

function target(row?: TargetRow): CapacityTarget {
  if (!row) return {
    enabled: false, intervalSeconds: 86400, nextRunAt: null,
    lastAttemptAt: null, lastSuccessAt: null, lastStatus: null, lastError: null,
    consecutiveFailures: 0,
  }
  return {
    enabled: row.enabled,
    intervalSeconds: row.interval_seconds,
    nextRunAt: iso(row.next_run_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastSuccessAt: iso(row.last_success_at),
    lastStatus: row.last_status,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  }
}

export function createCapacityStore(pools: Pools): CapacityStore {
  return {
    async history(connectionId, bucket, days) {
      const [t, p] = await Promise.all([
        pools.ro.query<TargetRow>(
          `SELECT connection_id, bucket, enabled, interval_seconds, next_run_at,
                  last_attempt_at, last_success_at, last_status, last_error, consecutive_failures
             FROM storage_capacity_targets WHERE connection_id = $1 AND bucket = $2`,
          [connectionId, bucket],
        ),
        pools.ro.query<{ total_bytes: string; object_count: string; collected_at: Date }>(
          `SELECT total_bytes, object_count, collected_at
             FROM storage_capacity_snapshots
            WHERE connection_id = $1 AND bucket = $2
              AND collected_at >= now() - ($3::text || ' days')::interval
            ORDER BY collected_at`,
          [connectionId, bucket, days],
        ),
      ])
      return {
        tracking: target(t.rows[0]),
        points: p.rows.map(row => ({
          totalBytes: safeNumber(row.total_bytes),
          objectCount: safeNumber(row.object_count),
          collectedAt: row.collected_at.toISOString(),
        })),
      }
    },

    async setTracking(connectionId, bucket, enabled, intervalSeconds, userId) {
      const r = await pools.rw.query<TargetRow & { changed: boolean }>(
        `WITH upserted AS (
         INSERT INTO storage_capacity_targets
           (connection_id, bucket, enabled, interval_seconds, next_run_at, last_status, updated_by)
         VALUES ($1, $2, $3, $4, now(), CASE WHEN $3 THEN 'waiting' ELSE 'paused' END, $5)
         ON CONFLICT (connection_id, bucket) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           interval_seconds = EXCLUDED.interval_seconds,
           next_run_at = CASE
             WHEN EXCLUDED.enabled AND (NOT storage_capacity_targets.enabled
               OR storage_capacity_targets.interval_seconds <> EXCLUDED.interval_seconds) THEN now()
             ELSE storage_capacity_targets.next_run_at END,
           last_status = CASE
             WHEN NOT EXCLUDED.enabled THEN 'paused'
             WHEN NOT storage_capacity_targets.enabled THEN 'waiting'
             ELSE storage_capacity_targets.last_status END,
           last_error = CASE
             WHEN NOT EXCLUDED.enabled OR NOT storage_capacity_targets.enabled THEN NULL
             ELSE storage_capacity_targets.last_error END,
           updated_at = now(), updated_by = EXCLUDED.updated_by
         WHERE storage_capacity_targets.enabled IS DISTINCT FROM EXCLUDED.enabled
            OR storage_capacity_targets.interval_seconds IS DISTINCT FROM EXCLUDED.interval_seconds
         RETURNING connection_id, bucket, enabled, interval_seconds, next_run_at,
                   last_attempt_at, last_success_at, last_status, last_error, consecutive_failures
         )
         SELECT upserted.*, true AS changed FROM upserted
         UNION ALL
         SELECT connection_id, bucket, enabled, interval_seconds, next_run_at,
                last_attempt_at, last_success_at, last_status, last_error, consecutive_failures,
                false AS changed
           FROM storage_capacity_targets
          WHERE connection_id = $1 AND bucket = $2
            AND NOT EXISTS (SELECT 1 FROM upserted)`,
        [connectionId, bucket, enabled, intervalSeconds, userId],
      )
      const row = r.rows[0]!
      return { changed: row.changed, tracking: target(row) }
    },

    async reserveDue(limit) {
      const r = await pools.rw.query<{ connection_id: string; bucket: string }>(
        `WITH due AS (
           SELECT connection_id, bucket FROM storage_capacity_targets
            WHERE enabled AND next_run_at <= now()
            ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE storage_capacity_targets t
            SET next_run_at = now() + interval '15 minutes',
                last_attempt_at = now(), last_status = 'queued', last_error = NULL
           FROM due
          WHERE t.connection_id = due.connection_id AND t.bucket = due.bucket
         RETURNING t.connection_id, t.bucket`,
        [limit],
      )
      return r.rows.map(row => ({ connectionId: row.connection_id, bucket: row.bucket }))
    },

    async attachJob(connectionId, bucket, jobId) {
      await pools.rw.query(
        `UPDATE storage_capacity_targets SET last_job_id = $3
          WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket, jobId])
    },

    async markPaused(connectionId, bucket) {
      await pools.rw.query(
        `UPDATE storage_capacity_targets
            SET last_status = 'paused', last_error = NULL,
                next_run_at = now() + make_interval(secs => interval_seconds)
          WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket])
    },

    async recordSuccess(jobId, connectionId, bucket, result) {
      const client = await pools.rw.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO storage_capacity_snapshots
             (connection_id, bucket, total_bytes, object_count, job_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING`,
          [connectionId, bucket, result.totalBytes, result.objectCount, jobId],
        )
        await client.query(
          `UPDATE storage_capacity_targets
              SET last_success_at = now(), last_status = 'success', last_error = NULL,
                  consecutive_failures = 0,
                  next_run_at = now() + make_interval(secs => interval_seconds)
            WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },

    async recordPartial(connectionId, bucket) {
      await pools.rw.query(
        `UPDATE storage_capacity_targets
            SET last_status = 'partial', last_error = '走査が途中で終了しました',
                consecutive_failures = consecutive_failures + 1,
                next_run_at = now() + interval '1 hour'
          WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket])
    },

    async recordError(connectionId, bucket, error) {
      await pools.rw.query(
        `UPDATE storage_capacity_targets
            SET last_status = 'error', last_error = $3,
                consecutive_failures = consecutive_failures + 1,
                next_run_at = now() + make_interval(secs => LEAST(21600,
                  900 * power(2, LEAST(consecutive_failures, 6))::integer))
          WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket, publicError(error)])
    },

    async prune(keepDays) {
      const r = await pools.rw.query(
        `DELETE FROM storage_capacity_snapshots
          WHERE collected_at < now() - ($1::text || ' days')::interval`, [keepDays])
      return r.rowCount ?? 0
    },
  }
}
