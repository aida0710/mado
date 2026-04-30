import {
  GetObjectCommand,
  NoSuchKey,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Hono, Context } from 'hono'
import { Readable } from 'node:stream'

export interface PreviewEnv {
  PREVIEW_TEXT_LIMIT: number
  PREVIEW_TAR_ENTRY_LIMIT: number
  PREVIEW_TARXZ_BYTE_LIMIT: number
}

export interface S3PreviewDeps {
  s3: S3Client
  env: PreviewEnv
}

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
}

const AUDIO_MIME: Record<string, string> = {
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  flac: 'audio/flac',
  ogg:  'audio/ogg',
}

function ext(key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key)
  return m ? m[1].toLowerCase() : ''
}

async function readN(
  stream: NodeJS.ReadableStream,
  n: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.byteLength
    if (total >= n) break
  }
  return Buffer.concat(chunks).subarray(0, n)
}

function s3Error(c: Context, e: unknown): Response {
  if (e instanceof NoSuchKey) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json({ error: (e as Error).message }, 500)
}

export function mountS3PreviewRoutes(app: Hono, deps: S3PreviewDeps): void {
  app.get('/api/s3/preview/text', async c => {
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    let buf: Buffer
    try {
      const r = await deps.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      buf = await readN(
        r.Body as unknown as NodeJS.ReadableStream,
        deps.env.PREVIEW_TEXT_LIMIT,
      )
    } catch (e) {
      return s3Error(c, e)
    }
    // Copy into a fresh ArrayBuffer-backed Uint8Array so it satisfies
    // BodyInit (ArrayBufferView<ArrayBuffer>) under TS strict typings.
    const body = new Uint8Array(buf.byteLength)
    body.set(buf)
    return new Response(body, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  })

  app.get('/api/s3/preview/image', async c => {
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    let stream: Readable
    let contentLength: number | undefined
    try {
      const r = await deps.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      stream = r.Body as unknown as Readable
      contentLength = r.ContentLength
    } catch (e) {
      return s3Error(c, e)
    }
    const mime = IMAGE_MIME[ext(key)] ?? 'application/octet-stream'
    const headers: Record<string, string> = { 'Content-Type': mime }
    if (contentLength != null) headers['Content-Length'] = String(contentLength)
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      { headers },
    )
  })

  app.get('/api/s3/preview/audio', async c => {
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    const range = c.req.header('Range')
    let stream: Readable
    let contentLength: number | undefined
    let contentRange: string | undefined
    try {
      const r = await deps.s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, Range: range,
      }))
      stream = r.Body as unknown as Readable
      contentLength = r.ContentLength
      contentRange = r.ContentRange
    } catch (e) {
      return s3Error(c, e)
    }
    const mime = AUDIO_MIME[ext(key)] ?? 'application/octet-stream'
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    }
    if (contentLength != null) headers['Content-Length'] = String(contentLength)
    if (contentRange) headers['Content-Range'] = contentRange
    const status = contentRange ? 206 : 200
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      { status, headers },
    )
  })
}
