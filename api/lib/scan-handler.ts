import { ListObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { z } from 'zod'
import type { GetStorage } from '../routes/_connId.js'
import type { ConnectionConfig } from '../storage.js'
import type { JobContext, JobHandler } from './job-runner.js'
import { createScanAccumulator } from './scan.js'

// storage.scan ハンドラ (spec: 2026-08-18-directory-scan-design.md)。
//
// Delimiter は付けない。区切り付きは CommonPrefixes の計算が重く、一部の S3 互換ストレージの
// dataset バケットでは prefix に関係なく 28〜35 秒かかる。付けなければ
// 0.095 秒 / ページで、547,259 キーでも約 223 秒 (実測)。
//
// MaxKeys は 1000。一覧の 100 と違い、ページ数を減らすのが目的。

const Payload = z.object({
  connId: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
})

const PAGE_SIZE = 1000

export interface ScanHandlerDeps {
  getStorage: GetStorage
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
}

export function createScanHandler(deps: ScanHandlerDeps): JobHandler {
  return async (ctx: JobContext) => {
    const { connId, bucket, prefix } = Payload.parse(ctx.payload)
    const storage = await deps.getStorage(connId)
    const config = await deps.getConnectionConfig(connId)
    const useV1 = config.listObjectsVersion === 'v1'

    const acc = createScanAccumulator(prefix)
    let cursor: string | undefined
    let partial = false

    for (;;) {
      if (ctx.signal.aborted) break

      let contents: Array<{ Key?: string; Size?: number }>
      let next: string | undefined
      try {
        if (useV1) {
          const out = await storage.send(new ListObjectsCommand({
            Bucket: bucket, Prefix: prefix, Marker: cursor, MaxKeys: PAGE_SIZE,
          }))
          contents = out.Contents ?? []
          // V1 は Delimiter 無しだと NextMarker を返さないことがあるので、
          // 最後のキーで marker フォールバックする (s3cmd と同じ手法)。
          next = out.IsTruncated
            ? out.NextMarker ?? contents[contents.length - 1]?.Key
            : undefined
        } else {
          const out = await storage.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: PAGE_SIZE,
          }))
          contents = out.Contents ?? []
          next = out.IsTruncated ? out.NextContinuationToken : undefined
        }
      } catch (e) {
        // ここまでの集計は返す。数十万キー数えた後に 1 ページの失敗で
        // 全部捨てるのは損なので。
        console.error(JSON.stringify({
          ev: 'storage.scan.page_failed', connId, bucket, prefix,
          scanned: acc.count(), error: (e as Error).message,
        }))
        partial = true
        break
      }

      for (const o of contents) {
        if (o.Key) acc.add({ key: o.Key, size: o.Size ?? 0 })
      }
      ctx.setProgress({ kind: 'count', done: acc.count(), label: '件を走査' })

      if (!next) break
      cursor = next
    }

    return acc.result(partial)
  }
}
