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
  app.get('/api/storage/:connId/buckets', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const out = await storage.send(new ListBucketsCommand({}))
    return c.json({
      buckets: (out.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    })
  })

  app.get('/api/storage/:connId/list', async c => {
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
