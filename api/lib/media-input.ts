import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { MediaAnalyzeError } from './media-analyze.js'
import { createPrivateMediaDirectory } from './media-temporary-directory.js'

// 解析3スロットで一時diskを使い切らない。動画の直接再生には適用しない。
const MAX_INPUT_BYTES = 2 * 1024 ** 3
const PROBE_BYTES = 256 * 1024

export async function spoolMediaInput({ source, signal, maxBytes = MAX_INPUT_BYTES }: {
  source: Readable; signal?: AbortSignal; maxBytes?: number
}) {
  let directory: string | null = null
  let sizeBytes = 0
  const cleanup = async () => { if (directory) await rm(directory, { recursive: true, force: true }) }
  try {
    directory = createPrivateMediaDirectory('media-input')
    const path = join(directory, 'input')
    const limited = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length
        callback(sizeBytes > maxBytes ? new MediaAnalyzeError('audio exceeds analysis limit', '') : null, chunk)
      },
    })
    await pipeline(source, limited, createWriteStream(path, { mode: 0o600 }), { signal })
    return {
      inputPath: path,
      openStream: async () => createReadStream(path),
      probeHead: async () => {
        const file = await open(path, 'r')
        try {
          const buffer = Buffer.alloc(Math.min(PROBE_BYTES, sizeBytes))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
          return buffer.subarray(0, bytesRead)
        } finally { await file.close() }
      },
      getSizeBytes: () => sizeBytes,
      cleanup,
    }
  } catch (error) { source.destroy(); await cleanup(); throw error }
}
