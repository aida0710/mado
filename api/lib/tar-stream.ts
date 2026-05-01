import { createGunzip } from 'node:zlib'
import { PassThrough, Transform, pipeline } from 'node:stream'
import { createRequire } from 'node:module'
import { extract as tarExtract } from 'tar-stream'

const require = createRequire(import.meta.url)

export type ArchiveKind = 'tar' | 'gz' | 'xz'

export interface TarEntry {
  name: string
  size: number
  type: string
}

export interface TarOptions {
  entryLimit: number
  byteLimit: number
  /** 収集を開始する前にスキップするエントリ数 — ページネーションカーソル。 */
  offset?: number
}

export interface TarListing {
  entries: TarEntry[]
  /** バイト上限 (またはアーカイブ途中のエントリ上限) に到達した場合 true; 結果は不完全。 */
  truncated: boolean
  /** 返されたページの後にさらに少なくとも1エントリ存在する。 */
  hasMore: boolean
}

function makeXzDecompressor(): NodeJS.ReadWriteStream {
  // ストリーミング xz サポートのために lzma-native を優先して使用する。
  // 現在の Node バージョンでネイティブバインディングのロードに失敗した場合は xz-decompress にフォールバック。
  try {
    const lzma = require('lzma-native') as {
      createDecompressor: () => NodeJS.ReadWriteStream
    }
    return lzma.createDecompressor()
  } catch (loadError) {
    throw new Error(
      'xz support requires `lzma-native` (or `xz-decompress`); '
      + 'install one of them or skip .tar.xz preview.',
      { cause: loadError },
    )
  }
}

// tar ストリームから特定の名前のエントリ本体を取り出してバイト列として解決する。
// tar-entry プレビュールートで使用。`byteLimit` で本体サイズを制限し、
// 悪意あるアーカイブエントリによるメモリ枯渇を防ぐ。
export function extractTarEntry(
  source: NodeJS.ReadableStream,
  kind: ArchiveKind,
  entryName: string,
  byteLimit: number,
): Promise<Buffer | null> {
  return new Promise((resolveP, rejectP) => {
    const ext = tarExtract()
    let found = false
    let truncated = false

    ext.on('entry', (header, stream, next) => {
      if (header.name !== entryName || found) {
        // パーサーを進めるために一致しないエントリをドレインする。
        stream.on('end', next)
        stream.resume()
        return
      }
      found = true
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => {
        if (total >= byteLimit) {
          truncated = true
          return
        }
        const remaining = byteLimit - total
        const piece = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(piece)
        total += piece.byteLength
      })
      stream.on('end', () => {
        // パイプラインの残りを破棄してダウンロードを停止する。
        ;(source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        ext.destroy()
        resolveP(Buffer.concat(chunks))
      })
      stream.resume()
      void truncated // 未使用変数の警告を抑制; 将来の呼び出し元用に予約
    })

    const decompressor: NodeJS.ReadWriteStream =
      kind === 'tar' ? new PassThrough()
      : kind === 'gz' ? createGunzip()
      : makeXzDecompressor()

    pipeline(source, decompressor, ext, err => {
      if (found) return // 本体を取得して既に解決済み
      if (err) rejectP(err)
      else resolveP(null) // エントリを見つけずに自然な EOF に達した
    })
  })
}

export function listTarEntries(
  source: NodeJS.ReadableStream,
  kind: ArchiveKind,
  opts: TarOptions,
  onEntry?: (entry: TarEntry) => void,
): Promise<TarListing> {
  const offset = opts.offset ?? 0
  return new Promise((resolveP, rejectP) => {
    const ext = tarExtract()
    const out: TarEntry[] = []
    let skipped = 0
    let bytes = 0
    let stopped = false
    let truncated = false
    let hasMore = false

    const stop = (reason: 'entry' | 'byte' | null) => {
      if (stopped) return
      stopped = true
      truncated = reason === 'byte'
      if (reason === 'entry') hasMore = true
      // パイプラインの先頭を破棄すると node:stream の pipeline() ヘルパーを通じて
      // 上流 (例: 上流ソケット) も閉じられる。既に破棄と決めたバイトを読み続けずに済む。
      ;(source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      ext.destroy()
      resolveP({ entries: out, truncated, hasMore })
    }

    ext.on('entry', (header, stream, next) => {
      // まずカーソル分をスキップする。
      if (skipped < offset) {
        skipped++
        stream.on('end', next)
        stream.resume()
        return
      }
      // 既に1ページ分取得済み; このエントリの存在が hasMore を意味する。
      if (out.length >= opts.entryLimit) {
        stream.resume()
        stop('entry')
        return
      }
      const entry: TarEntry = {
        name: header.name,
        size: header.size ?? 0,
        type: header.type ?? 'file',
      }
      out.push(entry)
      onEntry?.(entry)
      stream.on('end', next)
      stream.resume()
    })

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        if (stopped) return cb()
        bytes += (chunk as Buffer).byteLength
        if (bytes > opts.byteLimit) {
          stop('byte')
          return cb()
        }
        cb(null, chunk)
      },
    })

    const decompressor: NodeJS.ReadWriteStream =
      kind === 'tar' ? new PassThrough()
      : kind === 'gz' ? createGunzip()
      : makeXzDecompressor()

    // node:stream の pipeline() はエラーを転送し、失敗や破棄時にすべての
    // ステージをクリーンアップする。完了コールバックが自然な EOF での解決か
    // エラーでの拒否を行う唯一の場所となる。
    pipeline(source, decompressor, counter, ext, err => {
      if (stopped) return
      if (err) rejectP(err)
      else resolveP({ entries: out, truncated, hasMore })
    })
  })
}
