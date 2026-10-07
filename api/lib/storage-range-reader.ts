import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { RangeReader } from './tar-range.js'

export function makeStorageRangeReader({ storage, bucket, key, size, etag }: {
  storage: S3Client
  bucket: string
  key: string
  size: number
  etag?: string
}): RangeReader {
  return async (start, length, signal) => {
    if (start >= size) return Buffer.alloc(0)
    const end = Math.min(start + length, size) - 1
    const opened = await storage.send(new GetObjectCommand({
      Bucket: bucket, Key: key, Range: `bytes=${start}-${end}`, IfMatch: etag,
    }), { abortSignal: signal })
    const body = opened.Body as unknown as NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy(): void }
    // Rangeを無視するS3互換実装では、巨大な本文をバッファしない。
    if (opened.ContentRange !== `bytes ${start}-${end}/${size}`) {
      body.destroy()
      throw new Error('storage did not return the requested tar range')
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of body) {
      bytes += chunk.length
      if (bytes > end - start + 1) throw new Error('tar range response is too large')
      chunks.push(chunk)
    }
    if (bytes !== end - start + 1) throw new Error('incomplete tar range response')
    return Buffer.concat(chunks, bytes)
  }
}
