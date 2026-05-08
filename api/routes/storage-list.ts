import {
  ListBucketsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

export interface StorageListDeps {
  getStorage: GetStorage
}

export function mountStorageListRoutes(app: Hono, deps: StorageListDeps): void {
  app.get('/storage/:connId/buckets', async c => {
    // フェーズごとに所要時間を JSON ログに出して、
    // 「buckets が遅い」ときに getStorage / S3 の ListBuckets / 全体の
    // どこに時間がかかっているか切り分けられるようにする。
    const t0 = Date.now()
    const r = await resolveStorageOrFail(c, deps.getStorage)
    const t1 = Date.now()
    if (r instanceof Response) return r
    const storage = r
    const out = await storage.send(new ListBucketsCommand({}))
    const t2 = Date.now()
    console.log(JSON.stringify({
      ev: 'storage.buckets.timing',
      connId: c.req.param('connId'),
      getStorage_ms: t1 - t0,
      listBuckets_ms: t2 - t1,
      total_ms: t2 - t0,
      bucketCount: out.Buckets?.length ?? 0,
    }))
    return c.json({
      buckets: (out.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    })
  })

  app.get('/storage/:connId/list', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const continuation = c.req.query('continuation') || undefined
    const startAfter = c.req.query('startAfter') || undefined
    const out = await storage.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      // ContinuationToken 優先 (高速)。無いときだけ StartAfter で再開する。
      // S3 仕様上 ContinuationToken を渡すと StartAfter は無視されるが、
      // どちらか一方しか送らないほうが意図が明確。
      ContinuationToken: continuation,
      StartAfter: continuation ? undefined : startAfter,
      MaxKeys: 100,
    }))
    // DDN 互換 S3 (mdx 等) は IsTruncated=true を返すのに
    // NextContinuationToken を返さないことがある。その場合に最終キーで
    // フォールバック。AWS 公式 S3 では NextContinuationToken が常に入る
    // ので nextStartAfter は null のままになる。
    const realToken = out.NextContinuationToken ?? null
    const truncated = out.IsTruncated === true
    const rawContents = out.Contents ?? []
    const fallbackKey = !realToken && truncated && rawContents.length > 0
      ? rawContents[rawContents.length - 1].Key ?? null
      : null
    return c.json({
      directories: (out.CommonPrefixes ?? [])
        .map(p => p.Prefix!)
        .filter(Boolean),
      files: rawContents
        .filter(o => o.Key && o.Key !== prefix)
        .map(o => ({
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
      nextContinuation: realToken,
      nextStartAfter: fallbackKey,
    })
  })
}
