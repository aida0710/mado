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
  /** Skip this many entries before starting to collect — pagination cursor. */
  offset?: number
}

export interface TarListing {
  entries: TarEntry[]
  /** byte budget (or entry budget mid-archive) hit; result is incomplete. */
  truncated: boolean
  /** at least one more entry exists past the returned page. */
  hasMore: boolean
}

function makeXzDecompressor(): NodeJS.ReadWriteStream {
  // Prefer lzma-native for streaming xz support. Fall back to xz-decompress
  // if the native binding fails to load on the current Node version.
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

export function listTarEntries(
  source: NodeJS.ReadableStream,
  kind: ArchiveKind,
  opts: TarOptions,
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
      // Destroying the head of the pipeline propagates through node:stream's
      // pipeline() helper and closes upstream (e.g., the S3 socket) instead
      // of leaving us reading bytes we have already decided to discard.
      ;(source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      ext.destroy()
      resolveP({ entries: out, truncated, hasMore })
    }

    ext.on('entry', (header, stream, next) => {
      // Skip past the cursor first.
      if (skipped < offset) {
        skipped++
        stream.on('end', next)
        stream.resume()
        return
      }
      // Got a full page already; the existence of this entry means hasMore.
      if (out.length >= opts.entryLimit) {
        stream.resume()
        stop('entry')
        return
      }
      out.push({
        name: header.name,
        size: header.size ?? 0,
        type: header.type ?? 'file',
      })
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

    // node:stream's pipeline() forwards errors and cleans up all stages on
    // any failure or destruction. The completion callback is the single
    // place that resolves on natural EOF or rejects on error.
    pipeline(source, decompressor, counter, ext, err => {
      if (stopped) return
      if (err) rejectP(err)
      else resolveP({ entries: out, truncated, hasMore })
    })
  })
}
