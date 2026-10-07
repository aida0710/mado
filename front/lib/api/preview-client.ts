import type { z } from 'zod'
import { TarPreview } from './types'
import { removePersistedKeysStartingWith, SHORT_CACHE_TTL_MS, TTLCache } from './cache'
import { buildUrl, cacheKey, fetchOk, storagePath } from './http'
import { loadTarPreviewStream, type TarPreviewCallbacks } from './tar-preview-stream'
export type { TarEntry, TarPreviewCallbacks } from './tar-preview-stream'

const tarCache = new TTLCache<z.infer<typeof TarPreview>>(SHORT_CACHE_TTL_MS)

// 以前 tar も localStorage に永続化していたので、その残骸を起動時に一度だけ
// 掃除する。今のビルドはこのキーを読み書きしないため、放置しても害は無いが
// 容量を食うので消しておく。
removePersistedKeysStartingWith('mado.cache.tar:')

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

  // `<img src>` / audio・video / download用のtarエントリ本体へのURL形式。
  //
  // maxBytes を渡すと、サーバーはエントリの先頭 maxBytes だけを抽出して返す
  // (head モード)。テキストかどうか見るだけの用途で 100MB のエントリを丸ごと
  // 取得させないために使う。**<img src> / audio・video / downloadでは付けないこと**
  // — 本体が途中で切れる。
  tarEntryUrl: ({ connectionId, bucket, key, entry, maxBytes }: {
    connectionId: string; bucket: string; key: string; entry: string; maxBytes?: number
  }): string =>
    buildUrl(storagePath(connectionId, '/preview/tar-entry'), {
      bucket, key, entry,
      maxBytes: maxBytes != null ? String(maxBytes) : undefined,
    }),

  // URL の先頭 maxBytes だけ読み、残りは reader.cancel() で捨てる。
  //
  // テキストかどうか見るときはtarEntryUrlのmaxBytesも指定し、
  // サーバーで先頭取得、ブラウザで読み取り打ち切りの両方を行う。
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

  tarPreview: ({ connectionId, bucket, key, limit, offset, ...callbacks }: {
    connectionId: string; bucket: string; key: string; limit?: number; offset?: number
  } & TarPreviewCallbacks): Promise<z.infer<typeof TarPreview>> => {
    // (offset, limit) 単位でキャッシュ。同じページを再表示しても再 download しない。
    // tar.gz / tar.xz は 1 ページめくるたびにアーカイブ全体を再 download/decode
    // しているので効果が大きい。コールバック (onMode/onEntry/onProgress) は
    // キャッシュヒット時には呼ばれない (= 進捗 UI が出ないが、瞬時に終わる)。
    const pageKey = cacheKey('tar', connectionId, bucket, key, offset ?? 0, limit ?? 0)
    return tarCache.get(pageKey, async () => {
      return loadTarPreviewStream(buildUrl(storagePath(connectionId, '/preview/tar'), {
        bucket,
        key,
        limit:  limit  != null ? String(limit)  : undefined,
        offset: offset != null ? String(offset) : undefined,
      }), callbacks)
    })
  },

  // 1 アーカイブの全ページを破棄 (手動 refresh などから呼ぶ)。
  invalidateTarPreview: (connectionId: string, bucket: string, key: string): void => {
    tarCache.invalidatePrefix(cacheKey('tar', connectionId, bucket, key))
  },

  lastFetched: {
    tar: ({ connectionId, bucket, key, limit, offset }: {
      connectionId: string; bucket: string; key: string; limit?: number; offset?: number
    }): Date | null => {
      const at = tarCache.getFetchedAt(cacheKey('tar', connectionId, bucket, key, offset ?? 0, limit ?? 0))
      return at != null ? new Date(at) : null
    },
  },
}
