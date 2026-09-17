import type { Pools } from '../db.js'
import type { ScanResult } from './scan.js'

export const CAPACITY_INTERVALS = [21600, 43200, 86400, 259200, 604800] as const
export type CapacityStatus = 'waiting' | 'queued' | 'success' | 'partial' | 'error' | 'paused'

export interface CapacitySettings {
  enabled: boolean
  intervalSeconds: number
  nextRunAt: string | null
  lastAttemptAt: string | null
  lastStatus: 'waiting' | 'queued' | 'error' | 'paused'
  lastError: string | null
  consecutiveFailures: number
}

export interface CapacityPoint {
  totalBytes: number
  objectCount: number
  collectedAt: string
}

export interface CapacityBucketHistory {
  bucket: string
  lastSuccessAt: string | null
  lastStatus: CapacityStatus | null
  lastError: string | null
  points: CapacityPoint[]
}

export interface CapacityScanJob {
  jobId: number
  bucket: string
  status: 'queued' | 'running'
  objectCount: number
  createdAt: string
  startedAt: string | null
}

export interface CapacityScanActivity {
  jobs: CapacityScanJob[]
}

interface SettingsRow {
  connection_id: string
  enabled: boolean
  interval_seconds: number
  next_run_at: Date | null
  last_attempt_at: Date | null
  last_status: 'waiting' | 'queued' | 'error' | 'paused'
  last_error: string | null
  consecutive_failures: number
}

interface TargetRow {
  bucket: string
  last_success_at: Date | null
  last_status: CapacityStatus | null
  last_error: string | null
}

interface ScanJobRow {
  id: number
  bucket: string
  status: 'queued' | 'running'
  progress: { kind?: unknown; done?: unknown } | null
  created_at: Date
  started_at: Date | null
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

function settings(row?: SettingsRow): CapacitySettings {
  if (!row) return {
    enabled: false, intervalSeconds: 86400, nextRunAt: null,
    lastAttemptAt: null, lastStatus: 'paused', lastError: null, consecutiveFailures: 0,
  }
  return {
    enabled: row.enabled,
    intervalSeconds: row.interval_seconds,
    nextRunAt: iso(row.next_run_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastStatus: row.last_status,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  }
}

export interface CapacityStore {
  overview(connectionId: string, buckets: string[], days: number): Promise<{
    tracking: CapacitySettings
    buckets: CapacityBucketHistory[]
    scan: CapacityScanActivity
  }>
  scanActivity(connectionId: string): Promise<CapacityScanActivity>
  reserveDueConnections(limit: number): Promise<string[]>
  syncBuckets(connectionId: string, buckets: string[]): Promise<void>
  attachJob(connectionId: string, bucket: string, jobId: number): Promise<void>
  markConnectionScheduled(connectionId: string): Promise<void>
  markConnectionPaused(connectionId: string): Promise<void>
  recordConnectionError(connectionId: string, error: unknown): Promise<void>
  recordSuccess(jobId: number, connectionId: string, bucket: string, result: Pick<ScanResult, 'totalBytes' | 'objectCount'>): Promise<void>
  recordPartial(connectionId: string, bucket: string): Promise<void>
  recordError(connectionId: string, bucket: string, error: unknown): Promise<void>
  prune(keepDays: number): Promise<number>
}

function scanObjectCount(progress: ScanJobRow['progress']): number {
  const done = progress?.kind === 'count' ? Number(progress.done) : 0
  return Number.isSafeInteger(done) && done >= 0 ? done : 0
}

function toScanActivity(rows: ScanJobRow[]): CapacityScanActivity {
  return {
    jobs: rows.map(row => ({
      jobId: row.id,
      bucket: row.bucket,
      status: row.status,
      objectCount: scanObjectCount(row.progress),
      createdAt: row.created_at.toISOString(),
      startedAt: iso(row.started_at),
    })),
  }
}

async function loadScanActivity(pools: Pools, connectionId: string): Promise<CapacityScanActivity> {
  const result = await pools.ro.query<ScanJobRow>(
    `SELECT id, payload->>'bucket' AS bucket, status, progress, created_at, started_at
       FROM jobs
      WHERE kind = 'storage.scan'
        AND payload->>'connectionId' = $1
        AND COALESCE(payload->>'prefix', '') = ''
        AND status IN ('queued', 'running')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at, id`,
    [connectionId],
  )
  return toScanActivity(result.rows)
}

export function createCapacityStore(pools: Pools): CapacityStore {
  return {
    async overview(connectionId, bucketNames, days) {
      const buckets = [...new Set(bucketNames)]
      const [settingResult, targetResult, pointResult, scan] = await Promise.all([
        pools.ro.query<SettingsRow>(
          `SELECT connection_id, enabled, interval_seconds, next_run_at, last_attempt_at,
                  last_status, last_error, consecutive_failures
             FROM storage_capacity_settings WHERE connection_id = $1`, [connectionId]),
        pools.ro.query<TargetRow>(
          `SELECT bucket, last_success_at, last_status, last_error
             FROM storage_capacity_targets
            WHERE connection_id = $1 AND bucket = ANY($2::text[])`, [connectionId, buckets]),
        pools.ro.query<{ bucket: string; total_bytes: string; object_count: string; collected_at: Date }>(
          `SELECT bucket, total_bytes, object_count, collected_at
             FROM storage_capacity_snapshots
            WHERE connection_id = $1 AND bucket = ANY($2::text[])
              AND collected_at >= now() - ($3::text || ' days')::interval
            ORDER BY bucket, collected_at`, [connectionId, buckets, days]),
        loadScanActivity(pools, connectionId),
      ])
      const targets = new Map(targetResult.rows.map(row => [row.bucket, row]))
      const points = new Map<string, CapacityPoint[]>()
      for (const row of pointResult.rows) {
        const list = points.get(row.bucket) ?? []
        list.push({
          totalBytes: safeNumber(row.total_bytes), objectCount: safeNumber(row.object_count),
          collectedAt: row.collected_at.toISOString(),
        })
        points.set(row.bucket, list)
      }
      return {
        tracking: settings(settingResult.rows[0]),
        scan,
        buckets: buckets.map(bucket => {
          const status = targets.get(bucket)
          return {
            bucket, lastSuccessAt: iso(status?.last_success_at ?? null),
            lastStatus: status?.last_status ?? null, lastError: status?.last_error ?? null,
            points: points.get(bucket) ?? [],
          }
        }),
      }
    },

    async scanActivity(connectionId) {
      return loadScanActivity(pools, connectionId)
    },

    async reserveDueConnections(limit) {
      const result = await pools.rw.query<{ connection_id: string }>(
        `WITH due AS (
           SELECT connection_id FROM storage_capacity_settings
            WHERE enabled AND next_run_at <= now()
            ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE storage_capacity_settings s
            SET next_run_at = now() + interval '15 minutes', last_attempt_at = now(),
                last_status = 'queued', last_error = NULL
           FROM due WHERE s.connection_id = due.connection_id
         RETURNING s.connection_id`, [limit])
      return result.rows.map(row => row.connection_id)
    },

    async syncBuckets(connectionId, buckets) {
      if (buckets.length === 0) return
      await pools.rw.query(
        `INSERT INTO storage_capacity_targets
           (connection_id, bucket, enabled, interval_seconds, next_run_at, last_status)
         SELECT $1, bucket, COALESCE(s.enabled, false), COALESCE(s.interval_seconds, 86400),
                COALESCE(s.next_run_at, now()),
                CASE WHEN COALESCE(s.enabled, false) THEN 'waiting' ELSE 'paused' END
           FROM unnest($2::text[]) AS bucket
           LEFT JOIN storage_capacity_settings s ON s.connection_id = $1
         ON CONFLICT (connection_id, bucket) DO UPDATE SET
           enabled = EXCLUDED.enabled, interval_seconds = EXCLUDED.interval_seconds,
           next_run_at = EXCLUDED.next_run_at,
           last_status = CASE
             WHEN NOT EXCLUDED.enabled THEN 'paused'
             WHEN NOT storage_capacity_targets.enabled THEN 'waiting'
             ELSE storage_capacity_targets.last_status END,
           updated_at = now()`, [connectionId, [...new Set(buckets)]])
    },

    async attachJob(connectionId, bucket, jobId) {
      await pools.rw.query(
        `UPDATE storage_capacity_targets
            SET last_job_id = $3, last_status = 'queued', last_error = NULL, updated_at = now()
          WHERE connection_id = $1 AND bucket = $2`, [connectionId, bucket, jobId])
    },

    async markConnectionScheduled(connectionId) {
      await pools.rw.query(
        `UPDATE storage_capacity_settings
            SET next_run_at = now() + make_interval(secs => interval_seconds),
                last_status = 'waiting', consecutive_failures = 0, last_error = NULL
          WHERE connection_id = $1`, [connectionId])
    },

    async markConnectionPaused(connectionId) {
      await pools.rw.query(
        `UPDATE storage_capacity_settings
            SET last_status = 'paused', last_error = NULL,
                next_run_at = now() + make_interval(secs => interval_seconds)
          WHERE connection_id = $1`, [connectionId])
    },

    async recordConnectionError(connectionId, error) {
      await pools.rw.query(
        `UPDATE storage_capacity_settings
            SET last_status = 'error', last_error = $2,
                consecutive_failures = consecutive_failures + 1,
                next_run_at = now() + make_interval(secs => LEAST(21600,
                  900 * power(2, LEAST(consecutive_failures, 6))::integer))
          WHERE connection_id = $1`, [connectionId, publicError(error)])
    },

    async recordSuccess(jobId, connectionId, bucket, result) {
      const client = await pools.rw.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO storage_capacity_snapshots
             (connection_id, bucket, total_bytes, object_count, job_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING`,
          [connectionId, bucket, result.totalBytes, result.objectCount, jobId])
        await client.query(
          `INSERT INTO storage_capacity_targets
             (connection_id, bucket, enabled, interval_seconds, next_run_at, last_job_id,
              last_success_at, last_status, consecutive_failures)
           VALUES ($1, $2, false, 86400, now(), $3, now(), 'success', 0)
           ON CONFLICT (connection_id, bucket) DO UPDATE SET
             last_job_id = EXCLUDED.last_job_id, last_success_at = now(),
             last_status = 'success', last_error = NULL, consecutive_failures = 0,
             updated_at = now()`, [connectionId, bucket, jobId])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },

    async recordPartial(connectionId, bucket) {
      await pools.rw.query(
        `INSERT INTO storage_capacity_targets
           (connection_id, bucket, enabled, interval_seconds, next_run_at, last_status, last_error, consecutive_failures)
         VALUES ($1, $2, false, 86400, now(), 'partial', '走査が途中で終了しました', 1)
         ON CONFLICT (connection_id, bucket) DO UPDATE SET
           last_status = 'partial', last_error = '走査が途中で終了しました',
           consecutive_failures = storage_capacity_targets.consecutive_failures + 1,
           updated_at = now()`, [connectionId, bucket])
    },

    async recordError(connectionId, bucket, error) {
      await pools.rw.query(
        `INSERT INTO storage_capacity_targets
           (connection_id, bucket, enabled, interval_seconds, next_run_at, last_status, last_error, consecutive_failures)
         VALUES ($1, $2, false, 86400, now(), 'error', $3, 1)
         ON CONFLICT (connection_id, bucket) DO UPDATE SET
           last_status = 'error', last_error = EXCLUDED.last_error,
           consecutive_failures = storage_capacity_targets.consecutive_failures + 1,
           updated_at = now()`, [connectionId, bucket, publicError(error)])
    },

    async prune(keepDays) {
      const result = await pools.rw.query(
        `DELETE FROM storage_capacity_snapshots
          WHERE collected_at < now() - ($1::text || ' days')::interval`, [keepDays])
      return result.rowCount ?? 0
    },
  }
}
