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
    } catch (e) {
      // 「存在しない」だけを 404 に翻訳する。AccessDenied や 5xx を 404 に
      // 潰さない — それ以外は rethrow して internal.ts の onError
      // (explainStorageError) に翻訳させる。
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (
        err.name === 'NotFound' ||
        err.name === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404
      ) {
        return c.json({ error: 'not found' }, 404)
      }
      throw e
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
}
