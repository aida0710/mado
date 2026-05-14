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

/**
 * macOS が tar に紛れ込ませてくる「実際のファイルではない」メタデータ。
 * Mac の BSD tar / Finder の圧縮機能は各ファイルに拡張属性 (resource fork
 * 等) を AppleDouble 形式の `._<file>` として併存させる。これは中身が
 * 0x00 0x05 0x16 0x07 から始まるバイナリで、対応する `<file>` の WAV / JSON
 * とは別物 — そのまま preview/audio に渡すとブラウザがデコードに失敗する。
 *
 * `__MACOSX/` 配下ディレクトリと `.DS_Store` も同類のノイズ。listing API
 * からはまるごと隠す (entryLimit / offset の数え対象にもしない)。
 */
export function isMacOsMetadata(name: string): boolean {
  const base = name.split('/').filter(Boolean).pop() ?? name
  if (base.startsWith('._')) return true
  if (base === '.DS_Store') return true
  if (name === '__MACOSX' || name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return true
  return false
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

export interface TarEntryBody {
  buffer: Buffer
  /** byteLimit を超えてエントリ本体が打ち切られた場合 true。呼び出し元は 413 を返すべき。 */
  truncated: boolean
}

// tar ストリームから特定の名前のエントリ本体を取り出してバイト列として解決する。
// tar-entry プレビュールートで使用。`byteLimit` で本体サイズを制限し、
// 悪意あるアーカイブエントリによるメモリ枯渇を防ぐ。
// 上限到達時はバッファに収集済みのバイトと `truncated: true` を返し、
// 呼び出し元が 413 等で明示的に扱えるようにする (silent truncation を避ける)。
export function extractTarEntry(
  source: NodeJS.ReadableStream,
  kind: ArchiveKind,
  entryName: string,
  byteLimit: number,
): Promise<TarEntryBody | null> {
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
        if (chunk.byteLength > remaining) {
          // chunk を途中で切り捨てた = 本体は byteLimit より大きい。
          truncated = true
        }
      })
      stream.on('end', () => {
        // パイプラインの残りを破棄してダウンロードを停止する。
        ;(source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        ext.destroy()
        resolveP({ buffer: Buffer.concat(chunks), truncated })
      })
      stream.resume()
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
      // macOS の AppleDouble (`._*`) や `.DS_Store` 等は listing から除外。
      // offset / entryLimit のカウントにも入れない (見えない方の実体は読まない)。
      if (isMacOsMetadata(header.name)) {
        stream.on('end', next)
        stream.resume()
        return
      }
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
