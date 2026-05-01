import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// ランタイム機能フラグ。GET は現在のマップを返し、PUT は1つを切り替える。
// オナーシステム: 防御は LAN 境界に委ねる。

export interface SettingsDeps {
  pools: Pools
}

const PutBody = z.object({
  enabled: z.boolean(),
})

interface FlagRow {
  name: string
  enabled: boolean
}

export function mountSettingsRoutes(app: Hono, deps: SettingsDeps): void {
  app.get('/settings/flags', async c => {
    const r = await deps.pools.ro.query<FlagRow>(
      `SELECT name, enabled FROM feature_flags ORDER BY name`,
    )
    const map: Record<string, boolean> = {}
    for (const row of r.rows) map[row.name] = row.enabled
    return c.json(map)
  })

  app.put('/settings/flags/:name', async c => {
    const name = c.req.param('name')
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const r = await deps.pools.rw.query(
      `UPDATE feature_flags
         SET enabled = $1, updated_at = now()
         WHERE name = $2`,
      [parsed.data.enabled, name],
    )
    if (r.rowCount === 0) return c.json({ error: 'unknown flag' }, 404)
    return c.json({ ok: true, name, enabled: parsed.data.enabled })
  })
}

// 指定フラグが無効の場合 Hono ハンドラ内で 503 を返す。
// 有効 (または未知 — フェイルオープン) の場合は true を返す。
// 複数チェックが発生したときの冗長なクエリを避けるため Hono コンテキスト経由でリクエストごとにキャッシュする。
export async function isFlagEnabled(
  pools: Pools,
  name: string,
): Promise<boolean> {
  const r = await pools.ro.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE name = $1`,
    [name],
  )
  if (!r.rows[0]) return true
  return r.rows[0].enabled
}
