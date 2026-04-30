import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

export interface S3ReadmeDeps {
  s3: S3Client
  pools: Pools
}

const PutBody = z.object({
  bucket: z.string().min(1),
  prefix: z.string(),       // '' (root) or ends with '/'
  body: z.string(),
  editor: z.string().min(1),
})

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function isNoSuchKey(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const x = e as { name?: string; Code?: string }
  return x.name === 'NoSuchKey' || x.Code === 'NoSuchKey'
}

export function mountS3ReadmeRoutes(app: Hono, deps: S3ReadmeDeps): void {
  app.get('/api/s3/readme', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const Key = prefix + 'README.md'

    let body: string
    try {
      const r = await deps.s3.send(new GetObjectCommand({ Bucket: bucket, Key }))
      body = await streamToString(
        r.Body as unknown as NodeJS.ReadableStream
      )
    } catch (e) {
      if (isNoSuchKey(e)) return c.json({ exists: false })
      throw e
    }

    const meta = await deps.pools.ro.query(
      `SELECT last_editor, last_edited_at, size_bytes
         FROM s3_readme_meta WHERE bucket=$1 AND prefix=$2`,
      [bucket, prefix]
    )
    const m = meta.rows[0] as
      | { last_editor: string; last_edited_at: Date; size_bytes: number | null }
      | undefined
    return c.json({
      exists: true,
      body,
      last_editor: m?.last_editor ?? null,
      last_edited_at: m?.last_edited_at?.toISOString() ?? null,
      size_bytes: m?.size_bytes ?? body.length,
    })
  })

  app.put('/api/s3/readme', async c => {
    const parsed = PutBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    const { bucket, prefix, body, editor } = parsed.data
    const Key = prefix + 'README.md'
    const buf = Buffer.from(body, 'utf-8')

    try {
      await deps.s3.send(new PutObjectCommand({
        Bucket: bucket, Key, Body: buf, ContentType: 'text/markdown',
      }))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }

    await deps.pools.rw.query(
      `INSERT INTO s3_readme_meta(bucket, prefix, last_editor, last_edited_at, size_bytes)
       VALUES($1,$2,$3, now(), $4)
       ON CONFLICT (bucket, prefix) DO UPDATE
         SET last_editor    = EXCLUDED.last_editor,
             last_edited_at = EXCLUDED.last_edited_at,
             size_bytes     = EXCLUDED.size_bytes`,
      [bucket, prefix, editor, buf.byteLength]
    )

    return c.json({ ok: true, size_bytes: buf.byteLength })
  })
}
