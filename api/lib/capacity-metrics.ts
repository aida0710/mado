import type { Pool } from 'pg'
import { Hono } from 'hono'

export interface CapacityMetricRow {
  connection_id: string
  bucket: string
  consecutive_failures: number
  total_bytes: string | null
  object_count: string | null
  collected_at: Date | null
}

// The target table includes buckets whose first scan has not succeeded yet.
// The history index makes the lateral lookup select only the newest snapshot.
export async function loadCapacityMetricRows(pool: Pool): Promise<CapacityMetricRow[]> {
  const result = await pool.query<CapacityMetricRow>(
    `SELECT t.connection_id, t.bucket, t.consecutive_failures,
            snapshot.total_bytes, snapshot.object_count, snapshot.collected_at
       FROM storage_capacity_targets t
       LEFT JOIN LATERAL (
         SELECT total_bytes, object_count, collected_at
           FROM storage_capacity_snapshots
          WHERE connection_id = t.connection_id AND bucket = t.bucket
          ORDER BY collected_at DESC, id DESC LIMIT 1
       ) snapshot ON true
      ORDER BY t.connection_id, t.bucket`,
  )
  return result.rows
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labels(row: CapacityMetricRow): string {
  return `{connection_id="${escapeLabel(row.connection_id)}",bucket="${escapeLabel(row.bucket)}"}`
}

function metric(name: string, help: string, samples: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples]
}

export function renderCapacityMetrics(rows: CapacityMetricRow[], now = new Date()): string {
  const bytes: string[] = []
  const objects: string[] = []
  const age: string[] = []
  const failures: string[] = []

  for (const row of rows) {
    const label = labels(row)
    failures.push(`mado_storage_capacity_collection_failures${label} ${row.consecutive_failures}`)
    if (row.total_bytes === null || row.object_count === null || row.collected_at === null) continue
    // PostgreSQL BIGINT stays a decimal string: converting it to a JS number first
    // would lose precision before Prometheus receives it.
    bytes.push(`mado_storage_bucket_bytes${label} ${row.total_bytes}`)
    objects.push(`mado_storage_bucket_objects${label} ${row.object_count}`)
    age.push(`mado_storage_capacity_collection_age_seconds${label} ${Math.max(0, (now.getTime() - row.collected_at.getTime()) / 1000)}`)
  }

  return [
    ...metric('mado_storage_bucket_bytes', 'Latest measured bucket size in bytes.', bytes),
    ...metric('mado_storage_bucket_objects', 'Latest measured bucket object count.', objects),
    ...metric('mado_storage_capacity_collection_age_seconds', 'Seconds since the latest successful bucket scan.', age),
    ...metric('mado_storage_capacity_collection_failures', 'Consecutive failed bucket scans.', failures),
    '',
  ].join('\n')
}

export function createCapacityMetricsApp(load: () => Promise<CapacityMetricRow[]>): Hono {
  const app = new Hono()
  app.get('/metrics', async c => {
    try {
      const body = renderCapacityMetrics(await load())
      return c.body(body, 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      })
    } catch (error) {
      console.error('capacity metrics scrape failed', error)
      return c.text('metrics unavailable', 503)
    }
  })
  return app
}
