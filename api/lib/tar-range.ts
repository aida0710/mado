// Range-based tar header listing.
//
// Plain `.tar` is just `[header(512B) | body(padded to 512B)]*`. The streaming
// approach in tar-stream.ts has to *drain* every entry body to advance to the
// next header; for a 1 GB WebDataset shard with ~1 GB of body data, that means
// downloading ~1 GB just to enumerate the names. This file uses HTTP Range
// requests to skip the bodies entirely — for typical WebDataset shards, the
// first 100 entries cost ~100 × 512 B = 51 KB of network instead of hundreds
// of MB.
//
// Limitations:
//   * Only ustar / GNU-tar's `prefix` long-name layout is parsed. GNU `L`
//     long-link records and POSIX pax `x` headers fall back to whatever the
//     truncated 100-byte name field contains (still useful for WebDataset
//     keys, which are short).
//   * Only used for kind === 'tar'. Compressed archives go through the
//     streaming reader because the byte stream isn't seekable.

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { TarEntry } from './tar-stream.js'

export interface RangeOpts {
  entryLimit: number
  offset?: number
}

export interface RangeListing {
  entries: TarEntry[]
  hasMore: boolean
}

const HEADER_SIZE = 512
// Larger reads amortize per-request latency when the archive has many tiny
// entries packed back-to-back (e.g. WebDataset).
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
    if (header[0] === 0) { exhausted = true; break } // tar end-of-archive

    const parsed = parseTarHeader(header)
    if (!parsed) { exhausted = true; break }

    // tar metadata records (POSIX pax `x` / `g`, GNU long-name `L` / long-
    // link `K`) precede a real entry — they are not files in the archive.
    // Advance past them positionally but don't surface them.
    const isMetadata =
      parsed.type === 'x' || parsed.type === 'g' ||
      parsed.type === 'L' || parsed.type === 'K'

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

  // If we hit the entry cap, peek one header further to know whether
  // pagination has more.
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
  // All-zero block = end-of-archive.
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
    tflag  // L (GNU long name), x (pax), etc. — surface the raw flag

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
