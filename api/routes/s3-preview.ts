import {
  GetObjectCommand,
  NoSuchKey,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Hono, Context } from 'hono'
import { Readable } from 'node:stream'
import { listTarEntries, type ArchiveKind } from '../lib/tar-stream.js'
import { listTarHeadersByRange, makeS3RangeReader } from '../lib/tar-range.js'

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

function detectArchive(key: string): ArchiveKind | null {
  const k = key.toLowerCase()
  if (k.endsWith('.tar.gz') || k.endsWith('.tgz')) return 'gz'
  if (k.endsWith('.tar.xz')) return 'xz'
  if (k.endsWith('.tar'))    return 'tar'
  return null
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

  app.get('/api/s3/preview/tar', async c => {
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    const kind = detectArchive(key)
    if (!kind) {
      return c.json({ error: 'unsupported archive extension' }, 400)
    }
    // Hard upper bound on a single page. The UI offers 10 / 25 / 50 / 100;
    // anything past 100 would also blow up tar.gz/.xz decode memory.
    const MAX_LIMIT = 100
    const rawLimit = Number(c.req.query('limit') ?? deps.env.PREVIEW_TAR_ENTRY_LIMIT)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : Math.min(deps.env.PREVIEW_TAR_ENTRY_LIMIT, MAX_LIMIT)
    const rawOffset = Number(c.req.query('offset') ?? 0)
    const offset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : 0

    const byteLimit = kind === 'xz'
      ? deps.env.PREVIEW_TARXZ_BYTE_LIMIT
      : 1024 * 1024 * 1024 // 1 GiB ceiling for tar/tar.gz

    // Stream NDJSON. Lines are one of:
    //   {"mode":"range"|"stream"}              — first line, signals strategy
    //   {"entry":{name,size,type}}             — per discovered entry
    //   {"progress":{bytes,requests?}}         — periodic progress
    //   {"done":{truncated,hasMore,offset,limit}}
    //   {"error":"…"}
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (obj: unknown): void => {
          controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))
        }

        try {
          if (kind === 'tar') {
            // Plain tar: skip entry bodies via HTTP Range — for a 1 GB
            // WebDataset shard with mostly-body bytes, 100 entries cost
            // tens of KB of network instead of hundreds of MB.
            write({ mode: 'range' })
            const baseReader = makeS3RangeReader(deps.s3, bucket, key)
            let bytes = 0
            let requests = 0
            const reader: typeof baseReader = async (start, length) => {
              requests++
              const buf = await baseReader(start, length)
              bytes += buf.byteLength
              write({ progress: { bytes, requests } })
              return buf
            }
            const result = await listTarHeadersByRange(
              reader,
              { entryLimit: limit, offset },
              entry => write({ entry }),
            )
            write({
              done: {
                truncated: false,
                hasMore: result.hasMore,
                offset,
                limit,
              },
            })
          } else {
            write({ mode: 'stream' })
            // Compressed: must read every byte sequentially, so pipe the
            // S3 body through gunzip / lzma → tar-stream and emit entries
            // as they're parsed. Periodically emit byte progress.
            let s3stream: NodeJS.ReadableStream
            try {
              const r = await deps.s3.send(
                new GetObjectCommand({ Bucket: bucket, Key: key }),
              )
              s3stream = r.Body as unknown as NodeJS.ReadableStream
            } catch (e) {
              if (e instanceof NoSuchKey) {
                write({ error: 'not found' })
              } else {
                write({ error: (e as Error).message })
              }
              return
            }

            // Wrap the source so we can count compressed bytes downloaded.
            let bytes = 0
            let lastReported = 0
            const PROGRESS_STEP = 4 * 1024 * 1024 // every 4 MB
            ;(s3stream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength
              if (bytes - lastReported >= PROGRESS_STEP) {
                lastReported = bytes
                write({ progress: { bytes } })
              }
            })

            const result = await listTarEntries(
              s3stream,
              kind,
              { entryLimit: limit, byteLimit, offset },
              entry => write({ entry }),
            )
            write({ progress: { bytes } })
            write({
              done: {
                truncated: result.truncated,
                hasMore: result.hasMore,
                offset,
                limit,
              },
            })
          }
        } catch (e) {
          write({ error: (e as Error).message })
        } finally {
          controller.close()
        }
      },
    })
    return new Response(body, {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    })
  })
}
