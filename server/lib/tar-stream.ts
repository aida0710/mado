import { createGunzip } from 'node:zlib'
import { Transform } from 'node:stream'
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
): Promise<TarEntry[]> {
  return new Promise((resolveP, rejectP) => {
    const ext = tarExtract()
    const out: TarEntry[] = []
    let bytes = 0
    let stopped = false

    const stop = () => {
      if (stopped) return
      stopped = true
      ext.destroy()
      resolveP(out)
    }

    ext.on('entry', (header, stream, next) => {
      if (out.length >= opts.entryLimit) {
        stream.resume()
        stop()
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
    ext.on('finish', () => resolveP(out))
    ext.on('error', rejectP)

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += (chunk as Buffer).byteLength
        if (bytes > opts.byteLimit) {
          stop()
          cb()
          return
        }
        cb(null, chunk)
      },
    })

    let pipeline: NodeJS.ReadableStream
    if (kind === 'tar') pipeline = source
    else if (kind === 'gz') pipeline = source.pipe(createGunzip())
    else pipeline = source.pipe(makeXzDecompressor() as never)

    pipeline.pipe(counter).pipe(ext)
    pipeline.on('error', rejectP)
  })
}
