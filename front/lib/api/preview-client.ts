import type { z } from 'zod'
import { TarPreview } from './types'
import { SHORT_CACHE_TTL_MS, TTLCache } from './cache'
import { buildUrl, cacheKey, fetchOk, storagePath } from './http'

const tarCache = new TTLCache<z.infer<typeof TarPreview>>(SHORT_CACHE_TTL_MS)

// 以前 tar も localStorage に永続化していたので、その残骸を起動時に一度だけ
// 掃除する。今のビルドはこのキーを読み書きしないため、放置しても害は無いが
// 容量を食うので消しておく。失敗しても無害なので silent。
if (typeof localStorage !== 'undefined') {
  try {
    const victims: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('mado.cache.tar:')) victims.push(key)
    }
    for (const key of victims) localStorage.removeItem(key)
  } catch { /* silent */ }
}

export type TarEntry = z.infer<typeof TarPreview>['entries'][number]

export interface TarPreviewCallbacks {
  onMode?: (mode: 'range' | 'stream') => void
  onEntry?: (entry: TarEntry) => void
  onProgress?: (progress: { bytes: number; requests?: number }) => void
}

interface TarDone {
  truncated: boolean
  hasMore: boolean
  offset: number
  limit: number
}

/** NDJSON で流れてくる tar の一覧を読み切って TarPreview に組み立てる。各行は以下のいずれか:
 *    {"mode":"range"|"stream"} / {"entry":{name,size,type}} / {"progress":{bytes,requests?}}
 *    {"done":{truncated,hasMore,offset,limit}} / {"error":"..."}
 *  種別ごとにコールバックするため、ストリーム中に UI が「X 件 / Y MB / mode」を出せる。 */
async function readTarPreviewStream(res: Response, callbacks: TarPreviewCallbacks): Promise<z.infer<typeof TarPreview>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const entries: TarEntry[] = []
  let done: TarDone | null = null
  let pending = ''

  const handleLine = (line: string): void => {
    if (line.length === 0) return
    const record = JSON.parse(line) as Record<string, unknown>
    if ('mode' in record) {
      callbacks.onMode?.(record.mode as 'range' | 'stream')
    } else if ('entry' in record) {
      const entry = record.entry as TarEntry
      entries.push(entry)
      callbacks.onEntry?.(entry)
    } else if ('progress' in record) {
      callbacks.onProgress?.(record.progress as { bytes: number; requests?: number })
    } else if ('done' in record) {
      done = record.done as TarDone
    } else if ('error' in record) {
      throw new Error(String(record.error))
    }
  }

  while (true) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    pending += decoder.decode(value, { stream: true })
    // chunk ごとに分割: 最後の要素は incomplete 行なので pending に戻す。
    // 完了行 (\n 終端) のみを順に処理する。
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  // closure (handleLine) 経由で代入するので TS は narrow できない。
  // ここまで来れば必ず TarDone が入っていることを assert する。
  if (!done) throw new Error('tar stream ended without done marker')
  const finalDone: TarDone = done
  return TarPreview.parse({ entries, ...finalDone })
}

// preview 系の URL と、ブラウザ側で本文を扱う取得。画像 / 音声 / 動画は URL を
// そのまま要素に渡し、テキストと tar だけ JS で読む。
export const previewClient = {
  textPreviewUrl: (connectionId: string, bucket: string, key: string): string =>
    buildUrl(storagePath(connectionId, '/preview/text'), { bucket, key }),

  imageUrl: (connectionId: string, bucket: string, key: string): string =>
    buildUrl(storagePath(connectionId, '/preview/image'), { bucket, key }),

  audioUrl: (connectionId: string, bucket: string, key: string): string =>
    buildUrl(storagePath(connectionId, '/preview/audio'), { bucket, key }),

  videoUrl: (connectionId: string, bucket: string, key: string): string =>
    buildUrl(storagePath(connectionId, '/preview/video'), { bucket, key }),

  // 任意のキーをそのままダウンロードする URL。バックエンドが
  // Content-Disposition: attachment を付けるためブラウザはファイル保存を促す。
  downloadUrl: (connectionId: string, bucket: string, key: string): string =>
    buildUrl(storagePath(connectionId, '/preview/raw'), { bucket, key }),

  // `<img src>` / media blob / download用のtarエントリ本体へのURL形式。
  //
  // opts.maxBytes を渡すと、サーバーはエントリの先頭 maxBytes だけを抽出して返す
  // (head モード)。テキストかどうか見るだけの用途で 100MB のエントリを丸ごと
  // 解凍させないために使う。**<img src> / audio・video blob / downloadでは付けないこと**
  // — 本体が途中で切れる。
  tarEntryUrl: (
    connectionId: string, bucket: string, key: string, entry: string,
    opts: { maxBytes?: number } = {},
  ): string =>
    buildUrl(storagePath(connectionId, '/preview/tar-entry'), {
      bucket, key, entry,
      maxBytes: opts.maxBytes != null ? String(opts.maxBytes) : undefined,
    }),

  // URL の先頭 maxBytes だけ読み、残りは reader.cancel() で捨てる。
  //
  // /preview/tar-entry は Range 非対応で常に全量 (最大 100MB) を返す。テキストか
  // どうかを見るだけのために 100MB の npy を落としきるのは無駄なので、ストリームを
  // 途中で打ち切る。size を知らなくても安全なので、呼び出し側にサイズ上限の分岐が要らない。
  readHead: async (url: string, maxBytes: number): Promise<Uint8Array> => {
    const res = await fetchOk(url)
    // body が無い環境 (TS の型上 nullable) では stream を刻めない。せめて maxBytes で切る。
    if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes)

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
      }
    } finally {
      // 既に done でも cancel は解決する。打ち切り時はここで残りの転送が止まる。
      await reader.cancel().catch(() => { /* 二重 cancel は無視 */ })
    }

    const out = new Uint8Array(Math.min(total, maxBytes))
    let offset = 0
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, out.length - offset)
      out.set(chunk.subarray(0, take), offset)
      offset += take
    }
    return out
  },

  tarPreview: (
    connectionId: string,
    bucket: string,
    key: string,
    opts: { limit?: number; offset?: number } = {},
    callbacks: TarPreviewCallbacks = {},
  ): Promise<z.infer<typeof TarPreview>> => {
    // (offset, limit) 単位でキャッシュ。同じページを再表示しても再 download しない。
    // tar.gz / tar.xz は 1 ページめくるたびにアーカイブ全体を再 download/decode
    // しているので効果が大きい。コールバック (onMode/onEntry/onProgress) は
    // キャッシュヒット時には呼ばれない (= 進捗 UI が出ないが、瞬時に終わる)。
    const pageKey = cacheKey('tar', connectionId, bucket, key, opts.offset ?? 0, opts.limit ?? 0)
    return tarCache.get(pageKey, async () => {
      const res = await fetchOk(buildUrl(storagePath(connectionId, '/preview/tar'), {
        bucket,
        key,
        limit:  opts.limit  != null ? String(opts.limit)  : undefined,
        offset: opts.offset != null ? String(opts.offset) : undefined,
      }))
      return readTarPreviewStream(res, callbacks)
    })
  },

  // 1 アーカイブの全ページを破棄 (手動 refresh などから呼ぶ)。
  invalidateTarPreview: (connectionId: string, bucket: string, key: string): void => {
    tarCache.invalidatePrefix(cacheKey('tar', connectionId, bucket, key))
  },

  lastFetched: {
    tar: (
      connectionId: string,
      bucket: string,
      key: string,
      opts: { limit?: number; offset?: number } = {},
    ): Date | null => {
      const at = tarCache.getFetchedAt(cacheKey('tar', connectionId, bucket, key, opts.offset ?? 0, opts.limit ?? 0))
      return at != null ? new Date(at) : null
    },
  },
}
