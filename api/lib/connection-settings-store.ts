import { capabilitySettingKey, type Capabilities } from '../storage.js'

// 接続に紐づく設定 (connection_settings の key/value、ユーザー別ホワイトリスト、
// 容量計測設定) の DB 書き込み。route 側は検証と差分判定だけを持ち、SQL はここに集める。
// どれも呼び出し側の transaction (client) の中で使う。

export interface SettingsQueryable {
  query: (sql: string, values: unknown[]) => Promise<unknown>
}

/** connection_settings への key/value 書き込み。1 文 (UNNEST) にまとめるので、
 *  トグルを複数変えても往復は 1 回。 */
export async function upsertSettings(
  q: SettingsQueryable,
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
export async function deleteSettings(
  q: SettingsQueryable,
  connectionId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return
  await q.query(
    `DELETE FROM connection_settings WHERE connection_id = $1 AND key = ANY($2::text[])`,
    [connectionId, keys],
  )
}

/** 権限トグルは cap.* キーの 'true' / 'false'。既定 (行なし) は有効なので、
 *  設定画面で明示的に入れた値が行として見えるよう true も書き込む。 */
export async function upsertCapabilities(
  q: SettingsQueryable,
  connectionId: string,
  capabilities: Partial<Capabilities>,
): Promise<void> {
  const entries = (Object.keys(capabilities) as Array<keyof Capabilities>)
    .filter(key => capabilities[key] !== undefined)
    .map(key => [capabilitySettingKey(key), capabilities[key] ? 'true' : 'false'] as const)
  await upsertSettings(q, connectionId, entries)
}

export async function allowedUsersExist(
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

export async function replaceAllowedUsers(
  q: SettingsQueryable,
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

export async function upsertCapacitySettings(
  q: SettingsQueryable,
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
