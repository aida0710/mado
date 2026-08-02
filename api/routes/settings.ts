import type { Hono } from 'hono'
import type { Pools } from '../db.js'

// アプリ全体の設定 (接続に紐づかない、Mado 全体で 1 つ)。
// LAN 共有・認証なしで、README / Favorites と同じオナーシステム契約を踏襲する
// — 防御は LAN 境界に委ねる。
//
// 個別キーではなく GET /settings で全件返す。設定が増えるたびに画面表示時の
// ラウンドトリップが増えるのを避けるため。値は TEXT で、型の解釈は front 側。

export interface SettingsDeps {
  pools: Pools
}

// 書き込みを許すキーの許可リスト。未知のキーを弾いて、UI のタイプミスや
// 古いクライアントが設定表を汚さないようにする。
const WRITABLE_KEYS = new Set(['lineage_enabled', 'tags_enabled'])

export function mountSettingsRoutes(app: Hono, deps: SettingsDeps): void {
  app.get('/settings', async c => {
    const r = await deps.pools.ro.query(`SELECT key, value FROM app_settings`)
    const out: Record<string, string> = {}
    for (const row of r.rows) out[row.key as string] = row.value as string
    return c.json(out)
  })

  app.put('/settings/:key', async c => {
    const key = c.req.param('key')
    if (!WRITABLE_KEYS.has(key)) return c.json({ error: 'unknown setting key' }, 400)

    const body = await c.req.json().catch(() => null) as { value?: unknown } | null
    const value = body?.value
    if (typeof value !== 'string') return c.json({ error: 'value must be a string' }, 400)

    await deps.pools.rw.query(
      `INSERT INTO app_settings(key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    )
    return c.json({ ok: true })
  })
}
