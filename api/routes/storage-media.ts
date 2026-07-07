import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import {
  getCachedMedia,
  getCachedSpectrogram,
  mediaCacheKey,
} from '../lib/media-cache.js'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

export interface StorageMediaDeps {
  getStorage: GetStorage
  pools: Pools
  env: Env
  // テスト用に注入可能。既定はグローバル fetch。
  workerFetch?: typeof fetch
}

// media_jobs / dataset_stats の target_key。media-service.ts と同一形式。
// '\n' は S3 キーに現れないため安全な区切り。
function targetKey(connId: string, bucket: string, target: string): string {
  return [connId, bucket, target].join('\n')
}

export function mountStorageMediaRoutes(app: Hono, deps: StorageMediaDeps): void {
  const workerFetch = deps.workerFetch ?? fetch

  // 単一ファイルの解析。キャッシュ命中は即返し、未計算は media-worker に
  // 同期 proxy する (キューは通らない)。202 は返さない。
  app.get('/storage/:connId/media/analyze', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    const entryPath = c.req.query('entryPath') || undefined
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }

    let etag: string
    try {
      const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      etag = (head.ETag ?? '').replaceAll('"', '')
    } catch {
      return c.json({ error: 'not found' }, 404)
    }

    const ref = { connId, bucket, key, entryPath, etag }
    const cached = await getCachedMedia(deps.pools.ro, mediaCacheKey(ref))
    if (cached) return c.json(cached)

    // worker へ同期 proxy。ブラウザが切断したら中断が伝播する。
    let workerRes: Response
    try {
      workerRes = await workerFetch(`${deps.env.MEDIA_WORKER_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ref),
        signal: c.req.raw.signal,
      })
    } catch {
      return c.json({ error: 'media-worker に接続できません' }, 503)
    }
    return new Response(workerRes.body, {
      status: workerRes.status,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  app.get('/storage/:connId/media/spectrogram', async c => {
    const cacheKey = c.req.query('cacheKey')
    if (!cacheKey) return c.json({ error: 'cacheKey required' }, 400)
    const png = await getCachedSpectrogram(deps.pools.ro, cacheKey)
    if (!png) return c.json({ error: 'not found' }, 404)
    const body = new Uint8Array(png.byteLength)
    body.set(png)
    return new Response(body, {
      headers: {
        'Content-Type': 'image/png',
        // cacheKey は ETag 込みハッシュなので内容は不変
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })

  // ディレクトリ / tar スキャンをキューに投入する (これだけがキューを通る)。
  app.post('/storage/:connId/media/scan', async c => {
    const connId = c.req.param('connId')
    const body = (await c.req.json()) as { bucket?: string; prefix?: string; tarKey?: string }
    if (!body.bucket || (body.prefix == null && !body.tarKey)) {
      return c.json({ error: 'bucket and prefix or tarKey required' }, 400)
    }
    const target = body.tarKey ?? body.prefix ?? ''
    const tk = targetKey(connId, body.bucket, target)
    const payload = {
      connId,
      bucket: body.bucket,
      ...(body.tarKey ? { tarKey: body.tarKey } : { prefix: body.prefix ?? '' }),
    }
    // 部分ユニークインデックス (queued/processing のみ) と競合したら既存ジョブに合流
    const ins = await deps.pools.rw.query<{ id: number }>(
      `INSERT INTO media_jobs (target_key, payload)
       VALUES ($1, $2)
       ON CONFLICT (target_key) WHERE status IN ('queued','processing') DO NOTHING
       RETURNING id`,
      [tk, JSON.stringify(payload)],
    )
    let jobId = ins.rows[0]?.id
    if (jobId == null) {
      const existing = await deps.pools.ro.query<{ id: number }>(
        `SELECT id FROM media_jobs
          WHERE target_key = $1 AND status IN ('queued','processing')
          ORDER BY id DESC LIMIT 1`,
        [tk],
      )
      jobId = existing.rows[0]?.id
    }
    return c.json({ jobId }, 202)
  })

  app.get('/storage/:connId/media/scan-status', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    const prefix = c.req.query('prefix')
    const tarKey = c.req.query('tarKey')
    if (!bucket || (prefix == null && !tarKey)) {
      return c.json({ error: 'bucket and prefix or tarKey required' }, 400)
    }
    const tk = targetKey(connId, bucket, tarKey ?? prefix ?? '')
    const jobR = await deps.pools.ro.query<{
      id: number
      status: string
      progress: unknown
      error: string | null
    }>(
      `SELECT id, status, progress, error FROM media_jobs
        WHERE target_key = $1 ORDER BY id DESC LIMIT 1`,
      [tk],
    )
    const statsR = await deps.pools.ro.query<{ result: unknown; scanned_at: Date }>(
      'SELECT result, scanned_at FROM dataset_stats WHERE target_key = $1',
      [tk],
    )
    return c.json({
      job: jobR.rows[0] ?? null,
      stats: statsR.rows[0]?.result ?? null,
      scannedAt: statsR.rows[0]?.scanned_at?.toISOString() ?? null,
    })
  })

  app.post('/storage/:connId/media/scan-cancel', async c => {
    const body = (await c.req.json()) as { jobId?: number }
    if (body.jobId == null) return c.json({ error: 'jobId required' }, 400)
    await deps.pools.rw.query(
      `UPDATE media_jobs SET status = 'canceled', finished_at = now()
        WHERE id = $1 AND status IN ('queued','processing')`,
      [body.jobId],
    )
    return c.json({ ok: true })
  })
}
