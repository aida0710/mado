// Range リクエストを使った tar ヘッダー列挙。
//
// プレーン `.tar` は `[header(512B) | body(512Bパディング済み)]*` の繰り返しで構成される。
// tar-stream.ts のストリーミング方式は次のヘッダーへ進むためにエントリ本体を *ドレイン*
// しなければならない。1 GB の WebDataset シャード (本体 ~1 GB) ではファイル名の列挙だけで
// ~1 GB のダウンロードが発生する。本ファイルは HTTP Range リクエストを使って本体を丸ごとスキップ
// する。典型的な WebDataset シャードで最初の 100 エントリは ~100 × 512 B = 51 KB で済む。
//
// 制限:
//   * ustar / GNU-tar の `prefix` 形式の長名のみパース。GNU `L` (long-link レコード) や
//     POSIX pax `x` ヘッダーは切り詰め済みの 100 バイト名フィールドにフォールバックする
//     (WebDataset のキーは短いため実用上は問題ない)。
//   * kind === 'tar' のみ使用。圧縮アーカイブはバイトストリームがシーク不可なため
//     ストリーミングリーダーを使う。

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { isMacOsMetadata, type TarEntry } from './tar-stream.js'

export interface RangeOpts {
  entryLimit: number
  offset?: number
}

export interface RangeListing {
  entries: TarEntry[]
  hasMore: boolean
}

const HEADER_SIZE = 512
// 大きめのチャンクで読むことで、WebDataset のように小さなエントリが連続する場合の
// リクエスト往復コストを分散できる。
const CHUNK_SIZE = 256 * 1024

export type RangeReader = (start: number, length: number) => Promise<Buffer>

export function makeStorageRangeReader(
  storage: S3Client,
  bucket: string,
  key: string,
): RangeReader {
  return async (start, length) => {
    const r = await storage.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${start + length - 1}`,
    }))
    const chunks: Buffer[] = []
    for await (const c of r.Body as unknown as AsyncIterable<Buffer>) {
      chunks.push(c)
    }
    return Buffer.concat(chunks)
  }
}

export async function listTarHeadersByRange(
  read: RangeReader,
  opts: RangeOpts,
  onEntry?: (e: TarEntry) => void,
): Promise<RangeListing> {
  const out: TarEntry[] = []
  const offset = opts.offset ?? 0
  let skipped = 0
  let pos = 0
  let cache: { start: number; buf: Buffer } | null = null

  async function getBytes(at: number, n: number): Promise<Buffer> {
    if (cache && at >= cache.start && at + n <= cache.start + cache.buf.length) {
      return cache.buf.subarray(at - cache.start, at - cache.start + n)
    }
    const want = Math.max(n, CHUNK_SIZE)
    const buf = await read(at, want)
    cache = { start: at, buf }
    return buf.subarray(0, Math.min(n, buf.length))
  }

  let exhausted = false
  while (out.length < opts.entryLimit) {
    let header: Buffer
    try {
      header = await getBytes(pos, HEADER_SIZE)
    } catch {
      exhausted = true
      break
    }
    if (header.length < HEADER_SIZE) { exhausted = true; break }
    if (header[0] === 0) { exhausted = true; break } // tar アーカイブ終端

    const parsed = parseTarHeader(header)
    if (!parsed) { exhausted = true; break }

    // tar メタデータレコード (POSIX pax `x` / `g`、GNU 長名 `L` / long-link `K`) は
    // 実エントリの前置レコードであり、アーカイブ内のファイルではない。
    // 位置的にスキップするが列挙結果には含めない。
    // macOS の AppleDouble (`._*`) / `.DS_Store` / `__MACOSX/` も同様に隠す。
    const isMetadata =
      parsed.type === 'x' || parsed.type === 'g' ||
      parsed.type === 'L' || parsed.type === 'K' ||
      isMacOsMetadata(parsed.name)

    if (!isMetadata) {
      if (skipped < offset) {
        skipped++
      } else {
        out.push(parsed)
        onEntry?.(parsed)
      }
    }
    const padded = Math.ceil(parsed.size / HEADER_SIZE) * HEADER_SIZE
    pos += HEADER_SIZE + padded
  }

  // エントリ上限に達した場合、もう1つ先のヘッダーを確認してページネーションの
  // 続きがあるか判定する。
  let hasMore = false
  if (!exhausted && out.length >= opts.entryLimit) {
    try {
      const probe = await getBytes(pos, HEADER_SIZE)
      if (probe.length === HEADER_SIZE && probe[0] !== 0) hasMore = true
    } catch {
      hasMore = false
    }
  }

  return { entries: out, hasMore }
}

function parseTarHeader(buf: Buffer): TarEntry | null {
  // 全ゼロブロック = アーカイブ終端。
  let allZero = true
  for (let i = 0; i < HEADER_SIZE; i++) {
    if (buf[i] !== 0) { allZero = false; break }
  }
  if (allZero) return null

  const name100 = readCString(buf, 0, 100)
  const prefix = readCString(buf, 345, 155)
  const name = prefix ? `${prefix}/${name100}` : name100
  if (!name) return null

  const size = readOctal(buf, 124, 12)
  const tflag = String.fromCharCode(buf[156] || 0x30)
  const type =
    tflag === '0' || tflag === '\0' ? 'file' :
    tflag === '5' ? 'directory' :
    tflag === '2' ? 'symlink' :
    tflag  // L (GNU 長名)、x (pax) など — 生のフラグをそのまま返す

  return { name, size, type }
}

function readCString(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, off + len)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf-8')
}

function readOctal(buf: Buffer, off: number, len: number): number {
  const s = buf.subarray(off, off + len).toString('ascii')
    .replace(/\0.*$/, '').trim()
  if (!s) return 0
  const n = parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}
