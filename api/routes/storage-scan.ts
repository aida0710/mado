import type { Hono } from 'hono'
import type { BucketSettings } from '../lib/bucket-settings.js'
import type { JobStore } from '../lib/jobs.js'

// 走査ジョブの投入 (spec: 2026-08-18-directory-scan-design.md)。
// 汎用の POST /jobs は作らない。任意の kind と payload を外から投げられる口は
// 権限の観点でも入力検証の観点でも面倒が多いので、種別ごとに専用の口を持つ。

export const SCAN_KIND = 'storage.scan'

/** 実行中の同一ディレクトリを 1 本に合流させるためのキー。 */
export function scanDedupKey(connId: string, bucket: string, prefix: string): string {
  return `${connId}\n${bucket}\n${prefix}`
}

export interface StorageScanDeps {
  store: JobStore
  bucketSettings: { get(connId: string, bucket: string): Promise<BucketSettings> }
}

export function mountStorageScanRoutes(app: Hono, deps: StorageScanDeps): void {
  app.post('/storage/:connId/scan', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''

    // UI がボタンを隠していても共有 URL を直に叩けるので API 側でも止める。
    const settings = await deps.bucketSettings.get(connId, bucket)
    if (!settings.scanEnabled) {
      return c.json({ error: `このバケットでは走査が無効になっています: ${bucket}` }, 403)
    }

    const jobId = await deps.store.enqueue(
      SCAN_KIND,
      scanDedupKey(connId, bucket, prefix),
      { connId, bucket, prefix },
    )
    return c.json({ jobId })
  })
}
