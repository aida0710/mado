import {
  ListBucketsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'

export interface S3ListDeps {
  s3: S3Client
}

export function mountS3ListRoutes(app: Hono, deps: S3ListDeps): void {
  app.get('/api/s3/buckets', async c => {
    const r = await deps.s3.send(new ListBucketsCommand({}))
    return c.json({
      buckets: (r.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    })
  })

  app.get('/api/s3/list', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const continuation = c.req.query('continuation') || undefined
    const r = await deps.s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuation,
      MaxKeys: 100,
    }))
    return c.json({
      directories: (r.CommonPrefixes ?? [])
        .map(p => p.Prefix!)
        .filter(Boolean),
      files: (r.Contents ?? [])
        .filter(o => o.Key && o.Key !== prefix)
        .map(o => ({
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? null,
        })),
      nextContinuation: r.NextContinuationToken ?? null,
    })
  })
}
