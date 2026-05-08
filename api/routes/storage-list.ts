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
    const out = await storage.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuation,
      MaxKeys: 100,
    }))
    // S3 互換サービス (mdx = DDN 互換等) で NextContinuationToken が
    // 返らない / IsTruncated と矛盾するケースの切り分け用ログ。
    // 正常な S3 では IsTruncated=true のときに NextContinuationToken が
    // 必ず入る建前。
    console.log(JSON.stringify({
      ev: 'storage.list.s3resp',
      connId: c.req.param('connId'),
      bucket,
      prefix,
      hasContinuationIn: !!continuation,
      isTruncated: out.IsTruncated ?? null,
      keyCount: out.KeyCount ?? null,
      maxKeys: out.MaxKeys ?? null,
      hasNextContinuation: !!out.NextContinuationToken,
      contentsLength: out.Contents?.length ?? 0,
      commonPrefixesLength: out.CommonPrefixes?.length ?? 0,
    }))
    return c.json({
      directories: (out.CommonPrefixes ?? [])
        .map(p => p.Prefix!)
        .filter(Boolean),
      files: (out.Contents ?? [])
        .filter(o => o.Key && o.Key !== prefix)
        .map(o => ({
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
      nextContinuation: out.NextContinuationToken ?? null,
    })
  })
}
