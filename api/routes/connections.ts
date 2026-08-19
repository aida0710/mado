import type { Hono } from 'hono'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'
import type { CryptoModule } from '../crypto.js'
import {
  CONNECTION_SETTINGS_SUBQUERY,
  capabilitySettingKey,
  settingsToCapabilities,
  settingsToScanEnabled,
  settingsToListCacheTtlSec,
  type Capabilities,
} from '../storage.js'

// すべてのエンドポイントは認証なし。README/お気に入りのオナーシステム契約を踏襲し、
// 防御は LAN 境界に委ねる (ハンドラ内には持たない)。
// 認証情報は ENCRYPTION_KEY で保存時に暗号化されるため、
// 不正な作成/更新が既存のキーを漏洩させることはない。
export interface ConnectionsDeps {
  pools: Pools
  crypto: CryptoModule
  invalidate: (id: string) => void
}

// SSRF 緩和: cloud metadata (169.254.169.254) や同一ホスト内サービスへの
// 到達経路を断つ。RFC1918 (10/172.16/192.168) は LAN 内 MinIO 等の正当な
// ユースケースがあるため敢えて許可する。本リスト外の uri を反転検知する
// ホワイトリスト方式は LAN 信頼モデル下では過剰なので採用しない。
function isAllowedEndpoint(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '' || host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return false
  if (/^127\./.test(host)) return false                    // IPv4 loopback
  if (/^169\.254\./.test(host)) return false               // IPv4 link-local (cloud metadata 含む)
  if (/^fe[89ab][0-9a-f]?:/i.test(host)) return false      // IPv6 link-local
  if (/^0\.0\.0\.0/.test(host)) return false               // unspecified
  return true
}

const endpointSchema = z.string().url().max(512).refine(isAllowedEndpoint, {
  message: 'endpoint must not point to loopback, link-local, or unspecified addresses',
})

// listObjectsVersion: 'v2' は AWS S3 / Cloudflare R2 / MinIO 等の新しい実装向け。
// 'v1' は DDN 製のオブジェクトストレージや古い NetApp StorageGRID のように
// V2 を理解しない (= ?start-after= を無視して毎回先頭ページを返す) サーバ向け。
const ListObjectsVersionEnum = z.enum(['v1', 'v2'])

// 接続ごとの権限 (storage.ts の Capabilities と 1:1)。
// 既定はすべて true — 未指定で作った接続は今までどおり全機能が使える。
// 落とすのは「Deep Archive なのでダウンロードさせたくない」等の例外運用のとき。
const CapabilitiesBody = z.object({
  list:             z.boolean().default(true),
  preview:          z.boolean().default(true),
  download:         z.boolean().default(true),
  archive:          z.boolean().default(true),
  audioInfo:        z.boolean().default(true),
  audioSpectrogram: z.boolean().default(true),
  readmeRead:       z.boolean().default(true),
  readmeWrite:      z.boolean().default(true),
})

// 更新は差分。送られたキーだけ書き換える (UI がトグル 1 個だけ送れるように)。
const CapabilitiesPatch = CapabilitiesBody.partial()

/** connection_settings への upsert。値は TEXT なので 'true' / 'false' で持つ。
 *  「行が無い = 既定 (有効)」なので、既定に戻すだけなら DELETE でもよいが、
 *  設定画面で明示的に入れた値がそのまま行として見えるほうが追いやすいので
 *  true も書き込む。 */
/** connection_settings への素の key/value 書き込み (権限以外の接続別設定)。 */
async function upsertSettings(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connId: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  if (entries.length === 0) return
  await q.query(
    `INSERT INTO connection_settings (connection_id, key, value)
       SELECT $1, k, v FROM UNNEST($2::text[], $3::text[]) AS t(k, v)
     ON CONFLICT (connection_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [connId, entries.map(e => e[0]), entries.map(e => e[1])],
  )
}

async function upsertCapabilities(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connId: string,
  caps: Partial<Capabilities>,
): Promise<void> {
  const entries = (Object.keys(caps) as Array<keyof Capabilities>)
    .filter(k => caps[k] !== undefined)
    .map(k => [capabilitySettingKey(k), caps[k] ? 'true' : 'false'] as const)
  if (entries.length === 0) return
  // 1 文にまとめる (UNNEST) — トグルを複数変えても往復は 1 回。
  await q.query(
    `INSERT INTO connection_settings (connection_id, key, value)
       SELECT $1, k, v FROM UNNEST($2::text[], $3::text[]) AS t(k, v)
     ON CONFLICT (connection_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [connId, entries.map(e => e[0]), entries.map(e => e[1])],
  )
}

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  endpoint: endpointSchema,
  region: z.string().min(1).max(64).default('auto'),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256),
  forcePathStyle: z.boolean().default(true),
  listObjectsVersion: ListObjectsVersionEnum.default('v2'),
  // prefault: 入力側の既定。`capabilities` 自体が省略されたら `{}` を通し、
  // 各キーの .default(true) を効かせる (.default は出力側の型を要求するため使えない)。
  capabilities: CapabilitiesBody.prefault({}),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  endpoint: endpointSchema.optional(),
  region: z.string().min(1).max(64).optional(),
  accessKeyId: z.string().min(1).max(256).optional(),
  secretAccessKey: z.string().min(1).max(256).optional(),
  forcePathStyle: z.boolean().optional(),
  listObjectsVersion: ListObjectsVersionEnum.optional(),
  capabilities: CapabilitiesPatch.optional(),
  // 走査の可否と一覧キャッシュ TTL も connection_settings 側 (capabilities と同じ)。
  scanEnabled: z.boolean().optional(),
  listCacheTtlSec: z.number().int().positive().optional(),
})

interface ConnectionRow {
  id: string
  name: string
  endpoint: string
  region: string
  access_key_id_masked: string
  force_path_style: boolean
  list_objects_version: 'v1' | 'v2'
  is_default: boolean
  created_at: Date
  updated_at: Date
  settings: Record<string, string>
}

// 接続 1 件を返すための SELECT。connection_settings は別テーブルなので、
// RETURNING では取れず必ずこの SELECT を経由する (書き込み後も同じトランザクション内で読み直す)。
// エイリアスは `c` 固定 — CONNECTION_SETTINGS_SUBQUERY が `c.id` を参照する。
const SELECT_CONN =
  `SELECT c.id, c.name, c.endpoint, c.region, c.access_key_id_masked,
          c.force_path_style, c.list_objects_version, c.is_default,
          c.created_at, c.updated_at,
          ${CONNECTION_SETTINGS_SUBQUERY}
     FROM storage_connections c`

function toMasked(row: ConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    accessKeyIdMasked: row.access_key_id_masked,
    forcePathStyle: row.force_path_style,
    listObjectsVersion: row.list_objects_version,
    isDefault: row.is_default,
    capabilities: settingsToCapabilities(row.settings),
    scanEnabled: settingsToScanEnabled(row.settings),
    listCacheTtlSec: settingsToListCacheTtlSec(row.settings),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function mountConnectionsRoutes(app: Hono, deps: ConnectionsDeps): void {
  app.get('/connections', async c => {
    const r = await deps.pools.ro.query<ConnectionRow>(
      `${SELECT_CONN} ORDER BY c.name`,
    )
    return c.json(r.rows.map(toMasked))
  })

  app.post('/connections', async c => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle, listObjectsVersion, capabilities } = parsed.data
    if (capabilities.readmeWrite && !capabilities.readmeRead) {
      return c.json({ error: 'README の編集には読み込みが必要です' }, 400)
    }
    const id = nanoid(10)
    // 接続行と権限は別テーブルなので 1 トランザクションで書く。権限の書き込みだけ
    // 失敗して「全権限が既定 (= 全部有効)」の接続が残る fail-open を避ける。
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO storage_connections
           (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style, list_objects_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id, name, endpoint, region,
          deps.crypto.encrypt(accessKeyId),
          deps.crypto.encrypt(secretAccessKey),
          deps.crypto.mask(accessKeyId),
          forcePathStyle,
          listObjectsVersion,
        ],
      )
      await upsertCapabilities(client, id, capabilities)
      const r = await client.query<ConnectionRow>(`${SELECT_CONN} WHERE c.id = $1`, [id])
      await client.query('COMMIT')
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      await client.query('ROLLBACK')
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    } finally {
      client.release()
    }
  })

  // デフォルト接続の切り替え。トランザクションで「全解除 → 対象を設定」し、
  // 部分ユニークインデックス (storage_connections_default) が 1 件以下を保証する。
  app.put('/connections/:id/default', async c => {
    const id = c.req.param('id')
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      // 並行 PUT を直列化する (spec: 後勝ちで直列化)。read committed では
      // 全解除 UPDATE が並行コミットされた新デフォルト行を見えないため、
      // ロック無しだと部分ユニークインデックス違反で 500 になりうる。
      await client.query("SELECT pg_advisory_xact_lock(hashtext('storage_connections_default'))")
      await client.query('UPDATE storage_connections SET is_default = false WHERE is_default')
      const r = await client.query(
        'UPDATE storage_connections SET is_default = true WHERE id = $1',
        [id],
      )
      if (r.rowCount === 0) {
        await client.query('ROLLBACK')
        return c.json({ error: 'connection not found' }, 404)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return c.json({ ok: true })
  })

  app.put('/connections/:id', async c => {
    const id = c.req.param('id')
    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const u = parsed.data

    // 指定されたフィールドのみで動的な SET 句を構築する。
    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if (u.name !== undefined)            { sets.push(`name = $${i++}`);                  values.push(u.name) }
    if (u.endpoint !== undefined)        { sets.push(`endpoint = $${i++}`);              values.push(u.endpoint) }
    if (u.region !== undefined)          { sets.push(`region = $${i++}`);                values.push(u.region) }
    if (u.forcePathStyle !== undefined)  { sets.push(`force_path_style = $${i++}`);      values.push(u.forcePathStyle) }
    if (u.listObjectsVersion !== undefined) {
      sets.push(`list_objects_version = $${i++}`)
      values.push(u.listObjectsVersion)
    }
    if (u.accessKeyId !== undefined) {
      sets.push(`access_key_id_enc = $${i++}`);    values.push(deps.crypto.encrypt(u.accessKeyId))
      sets.push(`access_key_id_masked = $${i++}`); values.push(deps.crypto.mask(u.accessKeyId))
    }
    if (u.secretAccessKey !== undefined) {
      sets.push(`secret_access_key_enc = $${i++}`); values.push(deps.crypto.encrypt(u.secretAccessKey))
    }
    // capabilities は connection_settings 側 (別テーブル) なので SET 句には入らない。
    const caps = u.capabilities ?? {}
    const capKeys = (Object.keys(caps) as Array<keyof Capabilities>)
      .filter(k => caps[k] !== undefined)

    // 走査可否と一覧キャッシュ TTL も同じテーブル。key は名前空間を持たない
    // (cap.* は権限専用の接頭辞なので、こちらは素の名前で置く)。
    const extraSettings: Array<readonly [string, string]> = []
    if (u.scanEnabled !== undefined) {
      extraSettings.push(['scan_enabled', u.scanEnabled ? 'true' : 'false'])
    }
    if (u.listCacheTtlSec !== undefined) {
      extraSettings.push(['list_cache_ttl_sec', String(u.listCacheTtlSec)])
    }

    if (sets.length === 0 && capKeys.length === 0 && extraSettings.length === 0) {
      // 更新するフィールドがない — 現在の行をそのまま返す。
      const r = await deps.pools.ro.query<ConnectionRow>(
        `${SELECT_CONN} WHERE c.id = $1`, [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(toMasked(r.rows[0]))
    }

    // 接続行と権限で 2 テーブルに書くので 1 トランザクションにまとめる。
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')

      // 「README 編集には読み込みが必要」。key/value テーブルでは CHECK 制約に
      // できないので、送られなかった側の現在値と突き合わせてここで弾く。
      if (capKeys.length > 0) {
        const cur = await client.query<ConnectionRow>(
          `${SELECT_CONN} WHERE c.id = $1 FOR UPDATE OF c`, [id],
        )
        if (!cur.rows[0]) {
          await client.query('ROLLBACK')
          return c.json({ error: 'not found' }, 404)
        }
        const now = settingsToCapabilities(cur.rows[0].settings)
        const read  = caps.readmeRead  ?? now.readmeRead
        const write = caps.readmeWrite ?? now.readmeWrite
        if (write && !read) {
          await client.query('ROLLBACK')
          return c.json({ error: 'README の編集には読み込みが必要です' }, 400)
        }
      }

      if (sets.length > 0) {
        values.push(id)
        const r = await client.query(
          `UPDATE storage_connections SET ${sets.join(', ')} WHERE id = $${i}`,
          values,
        )
        if (r.rowCount === 0) {
          await client.query('ROLLBACK')
          return c.json({ error: 'not found' }, 404)
        }
      }
      await upsertCapabilities(client, id, caps)
      await upsertSettings(client, id, extraSettings)

      const r = await client.query<ConnectionRow>(`${SELECT_CONN} WHERE c.id = $1`, [id])
      await client.query('COMMIT')
      // 権限だけを変えた場合も storage factory のキャッシュを捨てる
      // (キャッシュは S3Client と ConnectionConfig を同じ entry に持っているため)。
      deps.invalidate(id)
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      await client.query('ROLLBACK')
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    } finally {
      client.release()
    }
  })

  app.delete('/connections/:id', async c => {
    const id = c.req.param('id')
    const r = await deps.pools.rw.query(
      `DELETE FROM storage_connections WHERE id = $1`, [id],
    )
    if (r.rowCount === 0) return c.json({ error: 'not found' }, 404)
    deps.invalidate(id)
    return c.json({ ok: true })
  })
}
