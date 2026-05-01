import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

// Both GET and PUT are intentionally unauthenticated. `editor` is self-reported
// (honor system). Defense lives at the LAN boundary, not in this handler. Do
// not add a Bearer middleware without reviewing the threat model.

export interface StorageReadmeDeps {
  getStorage: GetStorage
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

export function mountStorageReadmeRoutes(app: Hono, deps: StorageReadmeDeps): void {
  app.get('/api/storage/:connId/readme', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''
    const Key = prefix + 'README.md'

    let body: string
    try {
      const out = await storage.send(new GetObjectCommand({ Bucket: bucket, Key }))
      body = await streamToString(
        out.Body as unknown as NodeJS.ReadableStream,
      )
    } catch (e) {
      if (e instanceof NoSuchKey) return c.json({ exists: false })
      throw e
    }

    const meta = await deps.pools.ro.query(
      `SELECT last_editor, last_edited_at, size_bytes
         FROM storage_readme_meta
         WHERE connection_id=$1 AND bucket=$2 AND prefix=$3`,
      [connId, bucket, prefix]
    )
    const m = meta.rows[0] as
      | { last_editor: string; last_edited_at: Date; size_bytes: number | null }
      | undefined
    return c.json({
      exists: true,
      body,
      last_editor: m?.last_editor ?? null,
      last_edited_at: m?.last_edited_at?.toISOString() ?? null,
      size_bytes: m?.size_bytes ?? Buffer.byteLength(body, 'utf-8'),
    })
  })

  app.put('/api/storage/:connId/readme', async c => {
    const r = await resolveStorageOrFail(c, deps.getStorage)
    if (r instanceof Response) return r
    const storage = r
    const connId = c.req.param('connId')
    const parsed = PutBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    const { bucket, prefix, body, editor } = parsed.data
    const Key = prefix + 'README.md'
    const buf = Buffer.from(body, 'utf-8')

    try {
      await storage.send(new PutObjectCommand({
        Bucket: bucket, Key, Body: buf, ContentType: 'text/markdown',
      }))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }

    // Storage PUT succeeded. If the meta UPSERT now fails, the README body is
    // already on the object store — we still return 200 so the user knows their
    // save was persisted, but flag `meta_stale: true` so the front-end can show
    // a soft warning. The console.error gives the operator a breadcrumb to
    // investigate divergence between object store and DB.
    try {
      await deps.pools.rw.query(
        `INSERT INTO storage_readme_meta(connection_id, bucket, prefix, last_editor, last_edited_at, size_bytes)
         VALUES($1,$2,$3,$4, now(), $5)
         ON CONFLICT (connection_id, bucket, prefix) DO UPDATE
           SET last_editor    = EXCLUDED.last_editor,
               last_edited_at = EXCLUDED.last_edited_at,
               size_bytes     = EXCLUDED.size_bytes`,
        [connId, bucket, prefix, editor, buf.byteLength]
      )
    } catch (e) {
      console.error(JSON.stringify({
        ev: 'storage.readme.meta_failed',
        connId, bucket, prefix, editor,
        error: (e as Error).message,
      }))
      return c.json({ ok: true, meta_stale: true, size_bytes: buf.byteLength })
    }

    return c.json({ ok: true, size_bytes: buf.byteLength })
  })
}
