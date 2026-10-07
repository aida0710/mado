import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3'
import type { Context } from 'hono'
import { Readable } from 'node:stream'
import type { ObjectRequest } from './_storageRequest.js'
import { TarScanPendingError } from '../lib/tar-scan-budget.js'
import { RequestQueueFullError } from '../lib/shared-requests.js'
import { TarIndexLimitError } from '../lib/tar-index-store.js'

export function storageError(c: Context, error: unknown): Response {
  if (error instanceof TarIndexLimitError) return c.json({ error: error.message }, 413)
  if (error instanceof TarScanPendingError) {
    return c.json({ error: error.message }, 202, { 'Retry-After': '1', 'X-Tar-Index-Pending': '1', 'Cache-Control': 'private, no-store' })
  }
  if (error instanceof RequestQueueFullError) return c.json({ error: error.message }, 503, { 'Retry-After': '1' })
  if (error instanceof NoSuchKey || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
    return c.json({ error: 'not found' }, 404)
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  if (status === 412) return c.json({ error: 'object changed; retry the request' }, 412)
  if (status === 416) return c.json({ error: 'range not satisfiable' }, 416)
  console.error('storage preview failed', {
    name: error instanceof Error ? error.name : 'unknown',
    status,
  })
  return c.json({ error: 'storage request failed' }, 500)
}

interface OpenedObject {
  body: Readable
  contentLength: number | undefined
  /** Range 指定時に S3 が返す "bytes a-b/total"。無ければ全体を返している。 */
  contentRange: string | undefined
}

/** GetObject を開いて本文ストリームを返す。失敗は storageError で Response にする。 */
export async function openObject(
  c: Context,
  { storage, bucket, key }: ObjectRequest,
  options: { range?: string; etag?: string; signal?: AbortSignal } = {},
): Promise<OpenedObject | Response> {
  try {
    const response = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: options.range, IfMatch: options.etag }), { abortSignal: options.signal })
    return {
      body: response.Body as unknown as Readable,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
    }
  } catch (error) {
    return storageError(c, error)
  }
}

/** 開いたオブジェクトをそのまま流す。Content-Range があれば 206 で返す。 */
export function streamObject(opened: OpenedObject, headers: Record<string, string>): Response {
  const merged: Record<string, string> = { 'Cache-Control': 'private, no-store', ...headers }
  if (opened.contentLength != null) merged['Content-Length'] = String(opened.contentLength)
  if (opened.contentRange) merged['Content-Range'] = opened.contentRange
  return new Response(
    // Web Streamの既定はチャンク数で数えるため、バイト数で背圧をかける。
    Readable.toWeb(opened.body, {
      strategy: { highWaterMark: opened.body.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as unknown as ReadableStream<Uint8Array>,
    { status: opened.contentRange ? 206 : 200, headers: merged },
  )
}
