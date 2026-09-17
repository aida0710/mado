import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import {
  getCachedMedia,
  getCachedSpectrogram,
  mediaCacheKey,
} from '../lib/media-cache.js'
import { resolveObjectOrFail, type GetStorage } from './_storageRequest.js'

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
  app.get('/storage/:connectionId/media/analyze', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const { storage, bucket, key } = object
    const connectionId = c.req.param('connectionId')
    const entryPath = c.req.query('entryPath') || undefined

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

    const ref = { connectionId, bucket, key, entryPath, etag }
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

  app.get('/storage/:connectionId/media/spectrogram', async c => {
    const cacheKey = c.req.query('cacheKey')
    if (!cacheKey) return c.json({ error: 'cacheKey required' }, 400)
    const png = await getCachedSpectrogram(deps.pools.ro, cacheKey)
    if (!png) return c.json({ error: 'not found' }, 404)
    const body = new Uint8Array(png.byteLength)
    body.set(png)
    return new Response(body, {
      headers: {
        'Content-Type': 'image/png',
        // 認証済みデータをshared/browser cacheへ永続保存しない。
        'Cache-Control': 'private, no-store',
      },
    })
  })
}
