import type { Hono } from 'hono'
import { z } from 'zod'
import { markAuditNoChange } from '../lib/audit-activity.js'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'
import type { CryptoModule } from '../crypto.js'
import { managesConnections, visibleConnectionIds } from '../lib/connection-access.js'
import { getSessionPrincipal } from '../lib/rbac.js'
import {
  CONNECTION_SETTINGS_SUBQUERY,
  capabilitySettingKey,
  settingsToCapabilities,
  settingsToScanEnabled,
  settingsToScanPageSize,
  settingsToCapacityMetricsEnabled,
  settingsToListCacheTtlSec,
  type Capabilities,
} from '../storage.js'
import {
  PRICING_SETTING_KEYS as PK,
  effectiveRates,
  settingsToProfile,
} from '../lib/pricing.js'
import { CAPACITY_INTERVALS } from '../lib/capacity-store.js'

// ルート単位のRBACは internal.ts で適用する。接続一覧はさらにここでユーザー別に
// 絞り込み、非許可の接続は存在自体を返さない。
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
// 'v1' は 一部の S3 互換実装のように
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

const VisibilityMode = z.enum(['public', 'whitelist'])
const AllowedUserIds = z.array(z.string().uuid()).max(256)
  .transform(ids => [...new Set(ids)].sort())
const VisibilityCreate = z.object({
  mode: VisibilityMode.default('public'),
  allowedUserIds: AllowedUserIds.default([]),
}).prefault({})
const VisibilityPatch = z.object({
  mode: VisibilityMode.optional(),
  allowedUserIds: AllowedUserIds.optional(),
}).strict()

const CapacityTrackingPatch = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int()
    .refine(value => CAPACITY_INTERVALS.includes(value as typeof CAPACITY_INTERVALS[number])),
}).strict()

/** connection_settings への upsert。値は TEXT なので 'true' / 'false' で持つ。
 *  「行が無い = 既定 (有効)」なので、既定に戻すだけなら DELETE でもよいが、
 *  設定画面で明示的に入れた値がそのまま行として見えるほうが追いやすいので
 *  true も書き込む。 */
/** connection_settings への素の key/value 書き込み (権限以外の接続別設定)。 */
async function upsertSettings(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connectionId: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  if (entries.length === 0) return
  await q.query(
    `INSERT INTO connection_settings (connection_id, key, value)
       SELECT $1, k, v FROM UNNEST($2::text[], $3::text[]) AS t(k, v)
     ON CONFLICT (connection_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [connectionId, entries.map(e => e[0]), entries.map(e => e[1])],
  )
}

/** connection_settings からキーを消す。「既定に戻す」= 行を消す、の意味。
 *  権限 (cap.*) が true も書き込むのと違い、見積もり設定は既定が
 *  「プロバイダから推定」なので、明示値の有無が意味を持つ。 */
async function deleteSettings(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connectionId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return
  await q.query(
    `DELETE FROM connection_settings WHERE connection_id = $1 AND key = ANY($2::text[])`,
    [connectionId, keys],
  )
}

async function upsertCapabilities(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connectionId: string,
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
    [connectionId, entries.map(e => e[0]), entries.map(e => e[1])],
  )
}

async function allowedUsersExist(
  q: { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> },
  userIds: readonly string[],
): Promise<boolean> {
  if (userIds.length === 0) return true
  const result = await q.query(
    `SELECT id FROM auth_users
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [userIds],
  )
  return result.rows.length === userIds.length
}

async function replaceAllowedUsers(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connectionId: string,
  userIds: readonly string[],
  addedBy: string | null,
): Promise<void> {
  await q.query('DELETE FROM connection_user_allowlist WHERE connection_id = $1', [connectionId])
  if (userIds.length === 0) return
  await q.query(
    `INSERT INTO connection_user_allowlist (connection_id, user_id, added_by)
       SELECT $1, user_id, $3::uuid FROM UNNEST($2::uuid[]) AS selected(user_id)`,
    [connectionId, userIds, addedBy],
  )
}

async function upsertCapacitySettings(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  connectionId: string,
  value: { enabled: boolean; intervalSeconds: number },
  updatedBy: string | null,
): Promise<void> {
  await q.query(
    `INSERT INTO storage_capacity_settings
       (connection_id, enabled, interval_seconds, next_run_at, last_status, updated_by)
     VALUES ($1, $2, $3, CASE WHEN $2 THEN now() ELSE NULL END,
             CASE WHEN $2 THEN 'waiting' ELSE 'paused' END, $4)
     ON CONFLICT (connection_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       interval_seconds = EXCLUDED.interval_seconds,
       next_run_at = CASE
         WHEN NOT EXCLUDED.enabled THEN NULL
         WHEN NOT storage_capacity_settings.enabled
           OR storage_capacity_settings.interval_seconds <> EXCLUDED.interval_seconds THEN now()
         ELSE storage_capacity_settings.next_run_at END,
       last_status = CASE
         WHEN NOT EXCLUDED.enabled THEN 'paused'
         WHEN NOT storage_capacity_settings.enabled THEN 'waiting'
         ELSE storage_capacity_settings.last_status END,
       last_error = CASE
         WHEN NOT EXCLUDED.enabled OR NOT storage_capacity_settings.enabled THEN NULL
         ELSE storage_capacity_settings.last_error END,
       consecutive_failures = CASE
         WHEN NOT EXCLUDED.enabled OR NOT storage_capacity_settings.enabled THEN 0
         ELSE storage_capacity_settings.consecutive_failures END,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [connectionId, value.enabled, value.intervalSeconds, updatedBy],
  )
  await q.query(
    `UPDATE storage_capacity_targets
        SET enabled = $2, interval_seconds = $3,
            last_status = CASE WHEN $2 THEN last_status ELSE 'paused' END,
            updated_at = now()
      WHERE connection_id = $1`,
    [connectionId, value.enabled, value.intervalSeconds],
  )
}

// 転送見積もり用の接続プロファイル (spec: 2026-08-22-transfer-estimate-design.md)。
// 全て connection_settings の key/value なのでマイグレーションは要らない。
//
// **null は「既定に戻す」** (行を消す)。undefined は「触らない」。
// プロバイダは既定がエンドポイントからの推定なので、この区別が意味を持つ。
const ProviderEnum = z.enum(['aws', 'wasabi', 'onprem', 'other'])
const StorageClassEnum = z.enum([
  'STANDARD', 'INTELLIGENT_TIERING', 'STANDARD_IA', 'ONEZONE_IA',
  'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE',
])

const PricingPatch = z.object({
  provider:          ProviderEnum.nullable().optional(),
  region:            z.string().min(1).max(64).nullable().optional(),
  storageClass:      StorageClassEnum.nullable().optional(),
  readMbps:          z.number().positive().nullable().optional(),
  writeMbps:         z.number().positive().nullable().optional(),
  parallelism:       z.number().int().positive().nullable().optional(),
  requestOverheadMs: z.number().positive().nullable().optional(),
  // 0 (上振れ無し) は意味のある設定なので許す。
  instability:       z.number().min(0).nullable().optional(),
  capacityBytes:     z.number().positive().nullable().optional(),
  // 単価の手動上書き。0 は「無料」を意味するので許す。
  storagePerGbMonth: z.number().min(0).nullable().optional(),
  egressPerGb:       z.number().min(0).nullable().optional(),
  putPer1000:        z.number().min(0).nullable().optional(),
  getPer1000:        z.number().min(0).nullable().optional(),
})

type PricingPatch = z.infer<typeof PricingPatch>

/** body のフィールド名 → connection_settings のキー。 */
const PRICING_FIELD_KEYS: Record<keyof PricingPatch, string> = {
  provider:          PK.provider,
  region:            PK.region,
  storageClass:      PK.storageClass,
  readMbps:          PK.readMbps,
  writeMbps:         PK.writeMbps,
  parallelism:       PK.parallelism,
  requestOverheadMs: PK.requestOverheadMs,
  instability:       PK.instability,
  capacityBytes:     PK.capacityBytes,
  storagePerGbMonth: PK.storagePerGbMonth,
  egressPerGb:       PK.egressPerGb,
  putPer1000:        PK.putPer1000,
  getPer1000:        PK.getPer1000,
}

/** PricingPatch → (書き込む key/value, 消す key)。 */
function splitPricingPatch(
  patch: PricingPatch,
): { upserts: Array<readonly [string, string]>; deletes: string[] } {
  const upserts: Array<readonly [string, string]> = []
  const deletes: string[] = []
  for (const field of Object.keys(PRICING_FIELD_KEYS) as Array<keyof PricingPatch>) {
    const v = patch[field]
    if (v === undefined) continue
    if (v === null) deletes.push(PRICING_FIELD_KEYS[field])
    else upserts.push([PRICING_FIELD_KEYS[field], String(v)])
  }
  return { upserts, deletes }
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
  visibility: VisibilityCreate,
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
  scanPageSize: z.union([z.literal(100), z.literal(250), z.literal(500), z.literal(1000)]).optional(),
  capacityMetricsEnabled: z.boolean().optional(),
  listCacheTtlSec: z.number().int().positive().optional(),
  capacityTracking: CapacityTrackingPatch.optional(),
  pricing: PricingPatch.optional(),
  visibility: VisibilityPatch.optional(),
})

interface AllowedUserRow {
  id: string
  displayName: string
  username: string | null
  email: string | null
  status: 'active' | 'disabled'
}

interface ConnectionRow {
  id: string
  name: string
  endpoint: string
  region: string
  access_key_id_masked: string
  access_key_id_enc: string
  secret_access_key_enc: string
  force_path_style: boolean
  list_objects_version: 'v1' | 'v2'
  is_default: boolean
  visibility_mode: 'public' | 'whitelist'
  created_at: Date
  updated_at: Date
  settings: Record<string, string>
  capacity_tracking: { enabled: boolean; intervalSeconds: number }
  allowed_users: AllowedUserRow[]
}

// 接続 1 件を返すための SELECT。connection_settings は別テーブルなので、
// RETURNING では取れず必ずこの SELECT を経由する (書き込み後も同じトランザクション内で読み直す)。
// エイリアスは `c` 固定 — CONNECTION_SETTINGS_SUBQUERY が `c.id` を参照する。
const SELECT_CONN =
  `SELECT c.id, c.name, c.endpoint, c.region, c.access_key_id_masked,
          c.access_key_id_enc, c.secret_access_key_enc,
          c.force_path_style, c.list_objects_version, c.is_default,
          c.visibility_mode,
          c.created_at, c.updated_at,
          ${CONNECTION_SETTINGS_SUBQUERY},
          COALESCE((
            SELECT jsonb_build_object(
              'enabled', capacity.enabled,
              'intervalSeconds', capacity.interval_seconds
            ) FROM storage_capacity_settings capacity
             WHERE capacity.connection_id = c.id
          ), '{"enabled":false,"intervalSeconds":86400}'::jsonb) AS capacity_tracking,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', allowed_user.id,
              'displayName', allowed_user.display_name,
              'username', allowed_user.username,
              'email', allowed_user.email,
              'status', allowed_user.status
            ) ORDER BY lower(allowed_user.display_name), allowed_user.id)
              FROM connection_user_allowlist allowed
              JOIN auth_users allowed_user ON allowed_user.id = allowed.user_id
             WHERE allowed.connection_id = c.id
               AND allowed_user.deleted_at IS NULL
          ), '[]'::jsonb) AS allowed_users
     FROM storage_connections c`

function toMasked(row: ConnectionRow, includeAllowedUsers = true) {
  // 見積もりプロファイルは「設定 + 推定 + 既定」を畳んだ実効値を返す。
  // 何が明示設定で何が既定かは providerExplicit と各 override の null で分かる。
  const profile = settingsToProfile(row, row.settings)
  const rates = effectiveRates(profile)

  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    accessKeyIdMasked: row.access_key_id_masked,
    forcePathStyle: row.force_path_style,
    listObjectsVersion: row.list_objects_version,
    isDefault: row.is_default,
    visibility: {
      mode: row.visibility_mode,
      allowedUsers: includeAllowedUsers ? row.allowed_users : [],
    },
    capabilities: settingsToCapabilities(row.settings),
    scanEnabled: settingsToScanEnabled(row.settings),
    scanPageSize: settingsToScanPageSize(row.settings),
    capacityMetricsEnabled: settingsToCapacityMetricsEnabled(row.settings),
    listCacheTtlSec: settingsToListCacheTtlSec(row.settings),
    capacityTracking: row.capacity_tracking,
    pricing: {
      provider: profile.provider,
      /** false = エンドポイントからの推定。UI で「自動判定」と出すため。 */
      providerExplicit: row.settings[PK.provider] !== undefined,
      region: profile.region,
      storageClass: profile.storageClass,
      storageClassLabel: rates.storageClassLabel,
      /** カタログで単価を引けたか。false は「0 だが無料ではない」。 */
      ratesResolved: rates.ratesResolved,
      readMbps: profile.readMbps,
      writeMbps: profile.writeMbps,
      parallelism: profile.parallelism,
      requestOverheadMs: profile.requestOverheadMs,
      instability: profile.instability,
      capacityBytes: profile.capacityBytes,
      // 手動上書き。null = カタログに従う。
      storagePerGbMonth: profile.overrides.storagePerGbMonth,
      egressPerGb: profile.overrides.egressPerGb,
      putPer1000: profile.overrides.putPer1000,
      getPer1000: profile.overrides.getPer1000,
      // 上書きを適用した後の実効単価。設定画面に「今いくらで計算されるか」を出す。
      effective: {
        storagePerGbMonth: rates.storageTiers[0]?.usd ?? null,
        egressPerGb: rates.egressTiers[0]?.usd ?? null,
        putPer1000: rates.putPer1000,
        getPer1000: rates.getPer1000,
        retrievalPerGb: rates.retrievalPerGb,
        minDurationDays: rates.minDurationDays,
        minBillableBytes: rates.minBillableBytes,
        perObjectOverheadBytes: rates.perObjectOverheadBytes,
        /** 単価の出所。'manual' は「更新しても変わらない」ことを UI に出すため。 */
        storageRateSource: rates.storageRateSource,
      },
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function mountConnectionsRoutes(app: Hono, deps: ConnectionsDeps): void {
  app.get('/connections', async c => {
    const visible = await visibleConnectionIds(deps.pools.ro, c)
    const includeAllowedUsers = managesConnections(c)
    const r = await deps.pools.ro.query<ConnectionRow>(
      `${SELECT_CONN} ORDER BY c.name`,
    )
    return c.json(r.rows
      .filter(row => visible === null || visible.has(row.id))
      .map(row => toMasked(row, includeAllowedUsers)))
  })

  app.get('/connections/access-users', async c => {
    const result = await deps.pools.ro.query<{
      id: string
      display_name: string
      username: string | null
      email: string | null
      status: 'active' | 'disabled'
    }>(
      `SELECT id, display_name, username, email, status
         FROM auth_users
        WHERE deleted_at IS NULL
        ORDER BY lower(display_name), id`,
    )
    return c.json({ users: result.rows.map(user => ({
      id: user.id,
      displayName: user.display_name,
      username: user.username,
      email: user.email,
      status: user.status,
    })) })
  })

  app.post('/connections', async c => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const {
      name, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle,
      listObjectsVersion, capabilities, visibility,
    } = parsed.data
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
           (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc,
            access_key_id_masked, force_path_style, list_objects_version, visibility_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, name, endpoint, region,
          deps.crypto.encrypt(accessKeyId),
          deps.crypto.encrypt(secretAccessKey),
          deps.crypto.mask(accessKeyId),
          forcePathStyle,
          listObjectsVersion,
          visibility.mode,
        ],
      )
      if (!await allowedUsersExist(client, visibility.allowedUserIds)) {
        await client.query('ROLLBACK')
        return c.json({ error: 'ホワイトリストに存在しないユーザーが含まれています' }, 400)
      }
      await upsertCapabilities(client, id, capabilities)
      await replaceAllowedUsers(
        client, id, visibility.allowedUserIds, getSessionPrincipal(c)?.user.id ?? null,
      )
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
      const current = await client.query<{ is_default: boolean }>(
        'SELECT is_default FROM storage_connections WHERE id = $1 FOR UPDATE', [id],
      )
      if (!current.rows[0]) {
        await client.query('ROLLBACK')
        return c.json({ error: 'connection not found' }, 404)
      }
      if (current.rows[0].is_default) {
        await client.query('COMMIT')
        markAuditNoChange(c)
        return c.json({ ok: true })
      }
      await client.query('UPDATE storage_connections SET is_default = false WHERE is_default')
      await client.query('UPDATE storage_connections SET is_default = true WHERE id = $1', [id])
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
    if (u.visibility?.mode !== undefined) {
      sets.push(`visibility_mode = $${i++}`)
      values.push(u.visibility.mode)
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
    if (u.scanPageSize !== undefined) {
      extraSettings.push(['scan_page_size', String(u.scanPageSize)])
    }
    if (u.capacityMetricsEnabled !== undefined) {
      extraSettings.push(['capacity_metrics_enabled', u.capacityMetricsEnabled ? 'true' : 'false'])
    }
    if (u.listCacheTtlSec !== undefined) {
      extraSettings.push(['list_cache_ttl_sec', String(u.listCacheTtlSec)])
    }

    // 見積もりプロファイルも同じテーブル。こちらは null で「既定に戻す」= 行を
    // 消す操作があるので、書き込みと削除に振り分ける。
    const pricing = u.pricing
      ? splitPricingPatch(u.pricing)
      : { upserts: [], deletes: [] as string[] }
    extraSettings.push(...pricing.upserts)
    const allowedUserIds = u.visibility?.allowedUserIds

    if (sets.length === 0 && capKeys.length === 0 && extraSettings.length === 0
        && pricing.deletes.length === 0 && allowedUserIds === undefined
        && u.capacityTracking === undefined) {
      // 更新するフィールドがない — 現在の行をそのまま返す。
      const r = await deps.pools.ro.query<ConnectionRow>(
        `${SELECT_CONN} WHERE c.id = $1`, [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      markAuditNoChange(c)
      return c.json(toMasked(r.rows[0]))
    }

    // 接続行と権限で 2 テーブルに書くので 1 トランザクションにまとめる。
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')

      // 実変更の有無を、同じtransactionで対象行をlockした状態で判定する。
      // これにより同値PUTを記録せず、並行更新を古いreadで取り落とさない。
      const cur = await client.query<ConnectionRow>(
        `${SELECT_CONN} WHERE c.id = $1 FOR UPDATE OF c`, [id],
      )
      if (!cur.rows[0]) {
        await client.query('ROLLBACK')
        return c.json({ error: 'not found' }, 404)
      }
      const current = cur.rows[0]
      if (capKeys.length > 0) {
        const now = settingsToCapabilities(current.settings)
        const read  = caps.readmeRead  ?? now.readmeRead
        const write = caps.readmeWrite ?? now.readmeWrite
        if (write && !read) {
          await client.query('ROLLBACK')
          return c.json({ error: 'README の編集には読み込みが必要です' }, 400)
        }
      }
      const currentCaps = settingsToCapabilities(current.settings)
      const effectiveScanEnabled = u.scanEnabled ?? settingsToScanEnabled(current.settings)
      const effectiveCapacityMetricsEnabled = u.capacityMetricsEnabled
        ?? settingsToCapacityMetricsEnabled(current.settings)
      const effectiveCapacityEnabled = u.capacityTracking?.enabled ?? current.capacity_tracking.enabled
      if (effectiveCapacityEnabled && !effectiveScanEnabled) {
        await client.query('ROLLBACK')
        return c.json({ error: '容量の定期計測には配下の走査を許可する必要があります' }, 400)
      }
      if (effectiveCapacityEnabled && !effectiveCapacityMetricsEnabled) {
        await client.query('ROLLBACK')
        return c.json({ error: '容量の定期計測にはバケットのメトリクス集計を許可する必要があります' }, 400)
      }
      const currentAllowedUserIds = current.allowed_users.map(user => user.id).sort()
      const allowedUsersChanged = allowedUserIds !== undefined
        && (allowedUserIds.length !== currentAllowedUserIds.length
          || allowedUserIds.some((userId, index) => userId !== currentAllowedUserIds[index]))
      if (allowedUsersChanged && !await allowedUsersExist(client, allowedUserIds!)) {
        await client.query('ROLLBACK')
        return c.json({ error: 'ホワイトリストに存在しないユーザーが含まれています' }, 400)
      }
      const credentialsChanged = (u.accessKeyId !== undefined
          && u.accessKeyId !== deps.crypto.decrypt(current.access_key_id_enc))
        || (u.secretAccessKey !== undefined
          && u.secretAccessKey !== deps.crypto.decrypt(current.secret_access_key_enc))
      const rowChanged = credentialsChanged
        || (u.name !== undefined && u.name !== current.name)
        || (u.endpoint !== undefined && u.endpoint !== current.endpoint)
        || (u.region !== undefined && u.region !== current.region)
        || (u.forcePathStyle !== undefined && u.forcePathStyle !== current.force_path_style)
        || (u.listObjectsVersion !== undefined && u.listObjectsVersion !== current.list_objects_version)
        || (u.visibility?.mode !== undefined && u.visibility.mode !== current.visibility_mode)
      const capsChanged = capKeys.some(key => caps[key] !== currentCaps[key])
      const settingsChanged = extraSettings.some(([key, value]) => current.settings[key] !== value)
        || pricing.deletes.some(key => current.settings[key] !== undefined)
      const capacityChanged = u.capacityTracking !== undefined
        && (u.capacityTracking.enabled !== current.capacity_tracking.enabled
          || u.capacityTracking.intervalSeconds !== current.capacity_tracking.intervalSeconds)
      if (!rowChanged && !capsChanged && !settingsChanged && !allowedUsersChanged && !capacityChanged) {
        await client.query('COMMIT')
        markAuditNoChange(c)
        return c.json(toMasked(current))
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
      await deleteSettings(client, id, pricing.deletes)
      if (capacityChanged) {
        await upsertCapacitySettings(
          client, id, u.capacityTracking!, getSessionPrincipal(c)?.user.id ?? null,
        )
      }
      if (allowedUsersChanged) {
        await replaceAllowedUsers(
          client, id, allowedUserIds!, getSessionPrincipal(c)?.user.id ?? null,
        )
        // allowlistだけを変更した場合も接続の更新日時を進める。
        if (sets.length === 0) {
          await client.query('UPDATE storage_connections SET updated_at = now() WHERE id = $1', [id])
        }
      }
      if (capacityChanged && sets.length === 0 && !allowedUsersChanged) {
        await client.query('UPDATE storage_connections SET updated_at = now() WHERE id = $1', [id])
      }

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
