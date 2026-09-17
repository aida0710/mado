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
import { resolveObjectOrFail, type GetStorage, type ObjectRequest } from './_storageRequest.js'

export interface PreviewEnv {
  PREVIEW_TEXT_LIMIT: number
  PREVIEW_TAR_ENTRY_LIMIT: number
  PREVIEW_TARXZ_BYTE_LIMIT: number
  /**
   * メモリにバッファする tar エントリ 1 つのサイズ上限。既定 100 MB は
   * 典型的な WebDataset の音声サンプルをカバーしつつ、悪意あるアーカイブによる
   * ダッシュボードの OOM を防ぐ。media-service.ts の TAR_ENTRY_MAX_BYTES と同値。
   */
  PREVIEW_TAR_ENTRY_MAX_BYTES: number
}

export interface StoragePreviewDeps {
  getStorage: GetStorage
  env: PreviewEnv
}

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  gif:  'image/gif',
}

// front/lib/api/mime.ts の classify() の audio 拡張子集合と対応させること。
// ここに無い拡張子は audio として classify されても application/octet-stream で
// 返るため、ブラウザが再生を拒むことがある。
const AUDIO_MIME: Record<string, string> = {
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  flac: 'audio/flac',
  ogg:  'audio/ogg',
  oga:  'audio/ogg',
  opus: 'audio/ogg',
  m4a:  'audio/mp4',
  m4b:  'audio/mp4',
  aac:  'audio/aac',
  weba: 'audio/webm',
  aiff: 'audio/aiff',
  aif:  'audio/aiff',
  wma:  'audio/x-ms-wma',
}

// front/lib/api/mime.ts の video 拡張子集合と対応させること。
// 動画はブラウザが途中から読み込めるよう、audio と同じく Range を透過する。
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
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

// tar エントリ名の MIME タイプ (/storage/:connectionId/preview/tar-entry で使用)。
function entryContentType(name: string): string {
  const e = ext(name)
  if (IMAGE_MIME[e]) return IMAGE_MIME[e]
  if (AUDIO_MIME[e]) return AUDIO_MIME[e]
  if (VIDEO_MIME[e]) return VIDEO_MIME[e]
  if (e === 'json') return 'application/json; charset=utf-8'
  if (TEXT_EXT.has(e)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

// 正の整数のクエリ値。未指定 / 数値でない / 0 以下はすべて null に倒す
// (不正な値でモードが切り替わらないようにする)。
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
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
  console.error('storage preview failed', {
    name: e instanceof Error ? e.name : 'unknown',
    status: (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode,
  })
  return c.json({ error: 'storage request failed' }, 500)
}

interface OpenedObject {
  body: Readable
  contentLength: number | undefined
  /** Range 指定時に S3 が返す "bytes a-b/total"。無ければ全体を返している。 */
  contentRange: string | undefined
}

/** GetObject を開いて本文ストリームを返す。失敗は storageError で Response にする。 */
async function openObject(
  c: Context,
  { storage, bucket, key }: ObjectRequest,
  range?: string,
): Promise<OpenedObject | Response> {
  try {
    const r = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }))
    return {
      body: r.Body as unknown as Readable,
      contentLength: r.ContentLength,
      contentRange: r.ContentRange,
    }
  } catch (e) {
    return storageError(c, e)
  }
}

/** 開いたオブジェクトをそのまま流す。Content-Range があれば 206 で返す。 */
function streamObject(opened: OpenedObject, headers: Record<string, string>): Response {
  const merged: Record<string, string> = { 'Cache-Control': 'private, no-store', ...headers }
  if (opened.contentLength != null) merged['Content-Length'] = String(opened.contentLength)
  if (opened.contentRange) merged['Content-Range'] = opened.contentRange
  return new Response(
    Readable.toWeb(opened.body) as unknown as ReadableStream<Uint8Array>,
    { status: opened.contentRange ? 206 : 200, headers: merged },
  )
}

/** 音声・動画は途中から再生できるよう、ブラウザの Range をそのまま S3 へ渡す。 */
function mountRangeStreamRoute(
  app: Hono,
  deps: StoragePreviewDeps,
  path: string,
  mimeByExt: Record<string, string>,
): void {
  app.get(path, async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const opened = await openObject(c, object, c.req.header('Range'))
    if (opened instanceof Response) return opened
    return streamObject(opened, {
      'Content-Type': mimeByExt[ext(object.key)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    })
  })
}

export function mountStoragePreviewRoutes(app: Hono, deps: StoragePreviewDeps): void {
  app.get('/storage/:connectionId/preview/text', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const opened = await openObject(c, object)
    if (opened instanceof Response) return opened
    const buf = await readN(opened.body, deps.env.PREVIEW_TEXT_LIMIT)
    // TS の strict 型 (ArrayBufferView<ArrayBuffer>) で BodyInit を満たすため
    // 新しい ArrayBuffer バックの Uint8Array にコピーする。
    const body = new Uint8Array(buf.byteLength)
    body.set(buf)
    return new Response(body, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
    })
  })

  // 任意のキーをそのままダウンロードする (UI のダウンロードボタン用)。
  // image/audio プレビューと同じく Range ヘッダは透過しない (S3 GetObject の
  // 範囲リクエストはここで扱わず、ストリームを 1 度に流す)。Content-Type は
  // application/octet-stream に固定し、Content-Disposition: attachment で
  // ブラウザにファイル保存ダイアログを促す。
  app.get('/storage/:connectionId/preview/raw', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const opened = await openObject(c, object)
    if (opened instanceof Response) return opened
    const filename = object.key.split('/').pop() ?? 'file'
    // RFC 5987: ASCII fallback + UTF-8 真値で日本語ファイル名にも対応。
    const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '\\"')
    return streamObject(opened, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition':
        `attachment; filename="${asciiName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
    })
  })

  app.get('/storage/:connectionId/preview/image', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const opened = await openObject(c, object)
    if (opened instanceof Response) return opened
    return streamObject(opened, {
      'Content-Type': IMAGE_MIME[ext(object.key)] ?? 'application/octet-stream',
    })
  })

  mountRangeStreamRoute(app, deps, '/storage/:connectionId/preview/audio', AUDIO_MIME)
  mountRangeStreamRoute(app, deps, '/storage/:connectionId/preview/video', VIDEO_MIME)

  app.get('/storage/:connectionId/preview/tar', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const { storage, bucket, key } = object
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
    // クライアント切断 (ReadableStream の cancel()) は S3 オブジェクトストリームの
    // 'data' イベント発火と非同期に競合し得る。closed フラグと objStream は
    // start() と cancel() の双方から参照できるよう外側 (route ハンドラ) スコープに置く。
    let closed = false
    let objStream: NodeJS.ReadableStream | undefined
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (obj: unknown): void => {
          if (closed) return
          try {
            controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'))
          } catch {
            // controller が (cancel 等で) 既に閉じている場合。enqueue の同期 throw が
            // 'data' イベントハンドラの中で起きるとプロセスごと落ちるため、ここで握り潰す。
            closed = true
          }
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
            try {
              const r = await storage.send(
                new GetObjectCommand({ Bucket: bucket, Key: key }),
              )
              objStream = r.Body as unknown as NodeJS.ReadableStream
              // cancel() が storage.send の await 中 (objStream 未代入) に発火した
              // 場合、cancel() 側の destroy は届かない。代入直後に再チェックして
              // ダウンロードを確実に止める (この競合窓はタイミング依存のため
              // テストで決定的に踏むのは困難 — コードで塞ぐ)。
              if (closed) {
                ;(objStream as { destroy?: () => void }).destroy?.()
                return
              }
            } catch (e) {
              if (e instanceof NoSuchKey) {
                write({ error: 'not found' })
              } else {
                console.error('storage archive read failed', {
                  name: e instanceof Error ? e.name : 'unknown',
                  status: (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode,
                })
                write({ error: 'storage request failed' })
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
          console.error('storage archive preview failed', {
            name: e instanceof Error ? e.name : 'unknown',
          })
          write({ error: 'archive preview failed' })
        } finally {
          // cancel() で既に closed 済みなら二重 close しない。
          if (!closed) {
            closed = true
            try {
              controller.close()
            } catch {
              // 既に閉じている場合は無視。
            }
          }
        }
      },
      cancel() {
        // クライアント切断。write() を以後 no-op にし、stream モードで進行中の
        // S3 オブジェクトダウンロードを止める (range モードは 1 リクエストずつ
        // await するため巻き添え死はなく、objStream も存在しない)。
        closed = true
        ;(objStream as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined)?.destroy?.()
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'private, no-store',
      },
    })
  })

  // tar アーカイブから単一のエントリを取り出してその本体を返す。
  // フロントエンドはこれを使って tar 全体をダウンロードせずに WebDataset シャード内の
  // `.wav` を再生したり `.json` を表示したりする。
  app.get('/storage/:connectionId/preview/tar-entry', async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const { key } = object
    const entry = c.req.query('entry')
    if (!entry) {
      return c.json({ error: 'bucket, key and entry are required' }, 400)
    }
    const kind = detectArchive(key)
    if (!kind) {
      return c.json({ error: 'unsupported archive extension' }, 400)
    }

    const opened = await openObject(c, object)
    if (opened instanceof Response) return opened
    const stream: NodeJS.ReadableStream = opened.body

    // ?maxBytes=N を付けると「先頭 N バイトだけ」を 200 で返す (head モード)。
    // テキストか判定するだけのために 100MB のエントリを丸ごと解凍するのを避ける
    // ためのもので、クライアント側の abort はここまで届かない
    // (c.req.raw.signal は未配線)。付けなければ従来どおり全量 + 超過は 413。
    const maxBytes = deps.env.PREVIEW_TAR_ENTRY_MAX_BYTES
    const headBytes = parsePositiveInt(c.req.query('maxBytes'))
    const byteLimit = headBytes != null ? Math.min(headBytes, maxBytes) : maxBytes

    let result: { buffer: Buffer; truncated: boolean } | null
    try {
      result = await extractTarEntry(stream, kind, entry, byteLimit)
    } catch (e) {
      console.error('storage archive entry failed', {
        name: e instanceof Error ? e.name : 'unknown',
      })
      return c.json({ error: 'archive entry extraction failed' }, 500)
    }
    if (!result) {
      return c.json({ error: `entry not found: ${entry}` }, 404)
    }
    if (result.truncated && headBytes == null) {
      return c.json({
        error: `entry exceeds preview limit (${maxBytes} bytes)`,
      }, 413)
    }

    const buf = result.buffer
    const body = new Uint8Array(buf.byteLength)
    body.set(buf)
    const headers: Record<string, string> = {
      'Content-Type': entryContentType(entry),
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'private, no-store',
    }
    // head モードで実際に切り詰めたことを呼び出し側から見えるようにしておく
    // (プレビューが「全部」なのか「先頭だけ」なのかを区別したくなった時のため)。
    if (result.truncated) headers['X-Preview-Truncated'] = '1'
    return new Response(body, { headers })
  })
}
