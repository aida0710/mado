import type { Hono } from 'hono'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'
import type { CryptoModule } from '../crypto.js'

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
// 'v1' は MDX (s3ds.mdx.jp) や古い NetApp StorageGRID のように V2 を理解しない
// (= ?start-after= を無視して毎回先頭ページを返す) サーバ向け。
const ListObjectsVersionEnum = z.enum(['v1', 'v2'])

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  endpoint: endpointSchema,
  region: z.string().min(1).max(64).default('auto'),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256),
  forcePathStyle: z.boolean().default(true),
  listObjectsVersion: ListObjectsVersionEnum.default('v2'),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  endpoint: endpointSchema.optional(),
  region: z.string().min(1).max(64).optional(),
  accessKeyId: z.string().min(1).max(256).optional(),
  secretAccessKey: z.string().min(1).max(256).optional(),
  forcePathStyle: z.boolean().optional(),
  listObjectsVersion: ListObjectsVersionEnum.optional(),
})

interface ConnectionRow {
  id: string
  name: string
  endpoint: string
  region: string
  access_key_id_masked: string
  force_path_style: boolean
  list_objects_version: 'v1' | 'v2'
  created_at: Date
  updated_at: Date
}

function toMasked(row: ConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    accessKeyIdMasked: row.access_key_id_masked,
    forcePathStyle: row.force_path_style,
    listObjectsVersion: row.list_objects_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function mountConnectionsRoutes(app: Hono, deps: ConnectionsDeps): void {
  app.get('/connections', async c => {
    const r = await deps.pools.ro.query<ConnectionRow>(
      `SELECT id, name, endpoint, region, access_key_id_masked, force_path_style, list_objects_version, created_at, updated_at
         FROM storage_connections ORDER BY name`,
    )
    return c.json(r.rows.map(toMasked))
  })

  app.post('/connections', async c => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle, listObjectsVersion } = parsed.data
    const id = nanoid(10)
    try {
      const r = await deps.pools.rw.query<ConnectionRow>(
        `INSERT INTO storage_connections
           (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style, list_objects_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, name, endpoint, region, access_key_id_masked, force_path_style, list_objects_version, created_at, updated_at`,
        [
          id, name, endpoint, region,
          deps.crypto.encrypt(accessKeyId),
          deps.crypto.encrypt(secretAccessKey),
          deps.crypto.mask(accessKeyId),
          forcePathStyle,
          listObjectsVersion,
        ],
      )
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
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
    if (sets.length === 0) {
      // 更新するフィールドがない — 現在の行をそのまま返す。
      const r = await deps.pools.ro.query<ConnectionRow>(
        `SELECT id, name, endpoint, region, access_key_id_masked, force_path_style, list_objects_version, created_at, updated_at
           FROM storage_connections WHERE id = $1`,
        [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(toMasked(r.rows[0]))
    }
    values.push(id)
    try {
      const r = await deps.pools.rw.query<ConnectionRow>(
        `UPDATE storage_connections SET ${sets.join(', ')} WHERE id = $${i}
         RETURNING id, name, endpoint, region, access_key_id_masked, force_path_style, list_objects_version, created_at, updated_at`,
        values,
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      deps.invalidate(id)
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
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
