import type { Hono } from 'hono'
import { z } from 'zod'
import type { BucketSettings } from '../lib/bucket-settings.js'

// バケット単位の設定の読み書き (spec: 2026-08-18-directory-scan-design.md)。
// 書ける key は allowlist で絞る。任意のキーを書けると設定テーブルが野放しになり、
// 「どの key が意味を持つか」がコードから読めなくなるため。

const ALLOWED_KEYS = ['scan_enabled', 'list_cache_ttl_sec'] as const

const PutBody = z.object({
  key: z.enum(ALLOWED_KEYS),
  value: z.string().min(1).max(64),
}).refine(
  b => b.key !== 'list_cache_ttl_sec' || Number(b.value) > 0,
  { message: 'list_cache_ttl_sec は正の数で指定してください' },
).refine(
  b => b.key !== 'scan_enabled' || b.value === 'true' || b.value === 'false',
  { message: 'scan_enabled は true か false で指定してください' },
)

export interface BucketSettingsDeps {
  bucketSettings: {
    get(connId: string, bucket: string): Promise<BucketSettings>
    set(connId: string, bucket: string, key: string, value: string): Promise<void>
  }
}

export function mountBucketSettingsRoutes(app: Hono, deps: BucketSettingsDeps): void {
  app.get('/storage/:connId/bucket-settings', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    return c.json(await deps.bucketSettings.get(c.req.param('connId'), bucket))
  })

  app.put('/storage/:connId/bucket-settings', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    await deps.bucketSettings.set(
      c.req.param('connId'), bucket, parsed.data.key, parsed.data.value)
    return c.json({ ok: true })
  })
}
