import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { Hono } from 'hono'

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

function nodeToWeb(node: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      node.on('data',  c => controller.enqueue(c as Uint8Array))
      node.on('end',   () => controller.close())
      node.on('error', e => controller.error(e))
    },
  })
}

export function mountS3PreviewRoutes(app: Hono, deps: S3PreviewDeps): void {
  app.get('/api/s3/preview/text', async c => {
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    const r = await deps.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )
    const buf = await readN(
      r.Body as unknown as NodeJS.ReadableStream,
      deps.env.PREVIEW_TEXT_LIMIT,
    )
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
    const r = await deps.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )
    const mime = IMAGE_MIME[ext(key)] ?? 'application/octet-stream'
    const stream = r.Body as unknown as NodeJS.ReadableStream
    return new Response(nodeToWeb(stream), {
      headers: { 'Content-Type': mime },
    })
  })
}
