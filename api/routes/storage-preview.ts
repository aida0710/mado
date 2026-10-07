import {
  GetObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import {
  detectArchive,
  listTarEntries,
} from '../lib/tar-stream.js'
import { TarIndexCache } from '../lib/tar-index-cache.js'
import { TarScanPendingError } from '../lib/tar-scan-budget.js'
import { AUDIO_MIME, VIDEO_MIME, IMAGE_MIME, ext } from '../lib/preview-mime.js'
import { openObject, streamObject } from './_storageResponse.js'
import { mountStorageTarEntryRoute } from './storage-tar-entry.js'
import { resolveObjectOrFail, type GetStorage } from './_storageRequest.js'

export interface PreviewEnv {
  PREVIEW_TEXT_LIMIT: number
  PREVIEW_TAR_ENTRY_LIMIT: number
  PREVIEW_TARXZ_BYTE_LIMIT: number
  /**
   * 圧縮tarの本文バッファと、テキストの先頭取得の上限。
   * 非圧縮tarの本文はストリーミングし、この上限を適用しない。
   */
  PREVIEW_TAR_ENTRY_MAX_BYTES: number
}

export interface StoragePreviewDeps {
  getStorage: GetStorage
  env: PreviewEnv
}

// tar / tar.gz の一覧で読み進める上限。xz は解凍が重いので env で別に絞る。
// 1 GiB あれば典型的な WebDataset shard の header 走査は終わる。
const TAR_LIST_BYTE_LIMIT = 1024 * 1024 * 1024

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

/** 音声・動画は途中から再生できるよう、ブラウザの Range をそのまま S3 へ渡す。 */
function mountRangeStreamRoute({ app, deps, path, mimeByExt }: {
  app: Hono
  deps: StoragePreviewDeps
  path: string
  mimeByExt: Record<string, string>
}): void {
  app.get(path, async c => {
    const object = await resolveObjectOrFail(c, deps.getStorage)
    if (object instanceof Response) return object
    const opened = await openObject(c, object, { range: c.req.header('Range') })
    if (opened instanceof Response) return opened
    return streamObject(opened, {
      'Content-Type': mimeByExt[ext(object.key)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    })
  })
}

export function mountStoragePreviewRoutes(app: Hono, deps: StoragePreviewDeps): void {
  const tarIndexes = new TarIndexCache()
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

  mountRangeStreamRoute({ app, deps, path: '/storage/:connectionId/preview/audio', mimeByExt: AUDIO_MIME })
  mountRangeStreamRoute({ app, deps, path: '/storage/:connectionId/preview/video', mimeByExt: VIDEO_MIME })

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
      : TAR_LIST_BYTE_LIMIT

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
    const rangeController = new AbortController()
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
            write({ mode: 'range' })
            const archive = await tarIndexes.open({ storage, bucket, key, signal: rangeController.signal })
            try {
              let bytes = 0
              let requests = 0
              const result = await archive.index.list(
                {
                  entryLimit: limit, offset, signal: rangeController.signal,
                  onProgress: progress => {
                    bytes += progress.bytes
                    requests += progress.requests
                    write({ progress: { bytes, requests } })
                  },
                },
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
            } finally { archive.release() }
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
          if (closed) return
          if (e instanceof TarScanPendingError) { write({ pending: true }); return }
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
        // S3オブジェクトの取得とヘッダー走査を止める。
        closed = true
        rangeController.abort()
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

  mountStorageTarEntryRoute(app, { getStorage: deps.getStorage, maxBytes: deps.env.PREVIEW_TAR_ENTRY_MAX_BYTES, tarIndexes })
}
