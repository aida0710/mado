import {
  GetObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3'
import type { Hono, Context } from 'hono'
import { Readable } from 'node:stream'
import {
  extractTarEntry,
  listTarEntries,
  type ArchiveKind,
} from '../lib/tar-stream.js'
import { listTarHeadersByRange, makeStorageRangeReader } from '../lib/tar-range.js'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

export interface PreviewEnv {
  PREVIEW_TEXT_LIMIT: number
  PREVIEW_TAR_ENTRY_LIMIT: number
  PREVIEW_TARXZ_BYTE_LIMIT: number
}

export interface StoragePreviewDeps {
  getStorage: GetStorage
  env: PreviewEnv
}

// メモリにバッファするtarエントリ1つのサイズ上限。100 MB は
// 典型的な WebDataset の音声サンプルをカバーしつつ、悪意あるアーカイブによる
// ダッシュボードの OOM を防ぐ。
const TAR_ENTRY_MAX_BYTES = 100 * 1024 * 1024

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

const TEXT_EXT = new Set([
  'txt', 'md',
  'jsonl', 'ndjson',
  'yaml', 'yml',
  'csv', 'tsv', 'log',
])

// tar エントリ名の MIME タイプ (/storage/:connId/preview/tar-entry で使用)。
function entryContentType(name: string): string {
  const e = ext(name)
  if (IMAGE_MIME[e]) return IMAGE_MIME[e]
  if (AUDIO_MIME[e]) return AUDIO_MIME[e]
  if (e === 'json') return 'application/json; charset=utf-8'
  if (TEXT_EXT.has(e)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
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

function storageError(c: Context, e: unknown): Response {
  if (e instanceof NoSuchKey) {
    return c.json({ error: 'not found' }, 404)
  }
  return c.json({ error: (e as Error).message }, 500)
}

export function mountStoragePreviewRoutes(app: Hono, deps: StoragePreviewDeps): void {
  app.get('/storage/:connId/preview/text', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    let buf: Buffer
    try {
      const r = await storage.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      buf = await readN(
        r.Body as unknown as NodeJS.ReadableStream,
        deps.env.PREVIEW_TEXT_LIMIT,
      )
    } catch (e) {
      return storageError(c, e)
    }
    // TS の strict 型 (ArrayBufferView<ArrayBuffer>) で BodyInit を満たすため
    // 新しい ArrayBuffer バックの Uint8Array にコピーする。
    const body = new Uint8Array(buf.byteLength)
    body.set(buf)
    return new Response(body, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  })

  app.get('/storage/:connId/preview/image', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    let stream: Readable
    let contentLength: number | undefined
    try {
      const r = await storage.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      stream = r.Body as unknown as Readable
      contentLength = r.ContentLength
    } catch (e) {
      return storageError(c, e)
    }
    const mime = IMAGE_MIME[ext(key)] ?? 'application/octet-stream'
    const headers: Record<string, string> = { 'Content-Type': mime }
    if (contentLength != null) headers['Content-Length'] = String(contentLength)
    return new Response(
      Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      { headers },
    )
  })

  app.get('/storage/:connId/preview/audio', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
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
      const r = await storage.send(new GetObjectCommand({
        Bucket: bucket, Key: key, Range: range,
      }))
      stream = r.Body as unknown as Readable
      contentLength = r.ContentLength
      contentRange = r.ContentRange
    } catch (e) {
      return storageError(c, e)
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

  app.get('/storage/:connId/preview/tar', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }
    const kind = detectArchive(key)
    if (!kind) {
      return c.json({ error: 'unsupported archive extension' }, 400)
    }
    // 1ページの上限。UI は 10 / 25 / 50 / 100 を提供している;
    // 100 を超えると tar.gz/.xz デコードのメモリも爆発する。
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
      : 1024 * 1024 * 1024 // tar/tar.gz の上限 1 GiB

    // NDJSON をストリーミングする。各行は以下のいずれか:
    //   {"mode":"range"|"stream"}              — 最初の行、戦略を示す
    //   {"entry":{name,size,type}}             — 発見したエントリごと
    //   {"progress":{bytes,requests?}}         — 定期的な進捗
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
            // プレーン tar: HTTP Range でエントリ本体をスキップ — 本体データが大半の
            // 1 GB の WebDataset シャードで 100 エントリのコストが数百 MB ではなく
            // 数十 KB になる。
            write({ mode: 'range' })
            const baseReader = makeStorageRangeReader(storage, bucket, key)
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
            // 圧縮: 全バイトを順次読む必要があるため、オブジェクト本体を
            // gunzip / lzma -> tar-stream にパイプし、パース済みのエントリを
            // 都度出力する。定期的にバイト進捗も出力する。
            let objStream: NodeJS.ReadableStream
            try {
              const r = await storage.send(
                new GetObjectCommand({ Bucket: bucket, Key: key }),
              )
              objStream = r.Body as unknown as NodeJS.ReadableStream
            } catch (e) {
              if (e instanceof NoSuchKey) {
                write({ error: 'not found' })
              } else {
                write({ error: (e as Error).message })
              }
              return
            }

            // ダウンロードした圧縮バイト数をカウントできるようソースをラップする。
            let bytes = 0
            let lastReported = 0
            const PROGRESS_STEP = 4 * 1024 * 1024 // 4 MB ごと
            ;(objStream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
              bytes += chunk.byteLength
              if (bytes - lastReported >= PROGRESS_STEP) {
                lastReported = bytes
                write({ progress: { bytes } })
              }
            })

            const result = await listTarEntries(
              objStream,
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

  // tar アーカイブから単一のエントリを取り出してその本体を返す。
  // フロントエンドはこれを使って tar 全体をダウンロードせずに WebDataset シャード内の
  // `.wav` を再生したり `.json` を表示したりする。
  app.get('/storage/:connId/preview/tar-entry', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    const entry = c.req.query('entry')
    if (!bucket || !key || !entry) {
      return c.json({ error: 'bucket, key and entry are required' }, 400)
    }
    const kind = detectArchive(key)
    if (!kind) {
      return c.json({ error: 'unsupported archive extension' }, 400)
    }

    let stream: NodeJS.ReadableStream
    try {
      const r = await storage.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )
      stream = r.Body as unknown as NodeJS.ReadableStream
    } catch (e) {
      return storageError(c, e)
    }

    let result: { buffer: Buffer; truncated: boolean } | null
    try {
      result = await extractTarEntry(stream, kind, entry, TAR_ENTRY_MAX_BYTES)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
    if (!result) {
      return c.json({ error: `entry not found: ${entry}` }, 404)
    }
    if (result.truncated) {
      return c.json({
        error: `entry exceeds preview limit (${TAR_ENTRY_MAX_BYTES} bytes)`,
      }, 413)
    }

    const buf = result.buffer
    const body = new Uint8Array(buf.byteLength)
    body.set(buf)
    return new Response(body, {
      headers: {
        'Content-Type': entryContentType(entry),
        'Content-Length': String(buf.byteLength),
      },
    })
  })
}
