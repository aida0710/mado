import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { detectArchive, extractTarEntry } from './tar-stream.js'
import type { MediaRef } from './media-cache.js'
import type { TarIndexCache } from './tar-index-cache.js'
import { TarScanPendingError } from './tar-scan-budget.js'
import { MediaAnalyzeError } from './media-analyze.js'

// tarの音声解析は一度の処理量を絞る。動画の再生本文には適用しない。
const MAX_AUDIO_ENTRY_BYTES = 100 * 1024 * 1024

export async function openMediaSource({ storage, ref, tarIndexes, signal }: {
  storage: S3Client; ref: MediaRef; tarIndexes: TarIndexCache; signal: AbortSignal
}): Promise<Readable> {
  const request = { Bucket: ref.bucket, Key: ref.key, IfMatch: `"${ref.etag}"` }
  if (!ref.entryPath) {
    const opened = await storage.send(new GetObjectCommand(request), { abortSignal: signal })
    return opened.Body as Readable
  }
  const kind = detectArchive(ref.key)
  if (!kind) throw new MediaAnalyzeError('not an archive', '')
  if (kind === 'tar') {
    const archive = await tarIndexes.open({ storage, bucket: ref.bucket, key: ref.key, signal })
    try {
      if (archive.etag && archive.etag.replaceAll('"', '') !== ref.etag) throw new MediaAnalyzeError('object changed', '')
      let entry
      for (;;) {
        signal.throwIfAborted()
        try { entry = await archive.index.find(ref.entryPath, signal); break } catch (error) {
          if (!(error instanceof TarScanPendingError)) throw error
        }
      }
      if (!entry || entry.type !== 'file' || entry.size > MAX_AUDIO_ENTRY_BYTES) {
        throw new MediaAnalyzeError('entry not found or too large', '')
      }
      if (entry.bodyOffset + entry.size > archive.size) throw new MediaAnalyzeError('incomplete tar entry', '')
      if (entry.size === 0) return Readable.from([])
      const end = entry.bodyOffset + entry.size - 1
      const opened = await storage.send(new GetObjectCommand({ ...request, Range: `bytes=${entry.bodyOffset}-${end}` }), { abortSignal: signal })
      if (opened.ContentRange !== `bytes ${entry.bodyOffset}-${end}/${archive.size}` || opened.ContentLength !== entry.size) {
        ;(opened.Body as Readable).destroy()
        throw new MediaAnalyzeError('storage did not return the requested audio range', '')
      }
      return opened.Body as Readable
    } finally { archive.release() }
  }
  const opened = await storage.send(new GetObjectCommand(request), { abortSignal: signal })
  const body = opened.Body as Readable
  const abort = (): void => { body.destroy(new Error('aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const extracted = await extractTarEntry({ source: body, kind, entryName: ref.entryPath, byteLimit: MAX_AUDIO_ENTRY_BYTES })
    if (!extracted || extracted.truncated) throw new MediaAnalyzeError('entry not found or too large', '')
    return Readable.from(extracted.buffer)
  } finally { signal.removeEventListener('abort', abort); body.destroy() }
}
