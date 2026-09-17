import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createCrypto } from '../crypto.js'
import { mountConnectionsRoutes } from './connections.js'
import { requireConnectionAccess } from '../lib/connection-access.js'
import { setSessionPrincipal } from '../lib/rbac.js'
import type { SessionPrincipal } from '../lib/auth-types.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const TEST_KEY = 'a'.repeat(64)
const crypto = createCrypto(TEST_KEY)

const invalidate = vi.fn<(id: string) => void>()

const app = new Hono()
mountConnectionsRoutes(app, { pools, crypto, invalidate })

const ALLOWED_USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

function principal(userId: string, permissions: string[] = []): SessionPrincipal {
  return {
    kind: 'user',
    sessionId: `session-${userId}`,
    user: {
      id: userId,
      username: null,
      email: `${userId.slice(0, 8)}@example.com`,
      displayName: userId === ALLOWED_USER_ID ? '許可ユーザー' : 'その他ユーザー',
      signatureName: 'テスト',
      status: 'active',
      roles: [],
      permissions,
      mustChangePassword: false,
      authMethods: ['sso'],
    },
  }
}

function appFor(userId: string, permissions: string[] = []): Hono {
  const userApp = new Hono()
  userApp.use('*', async (c, next) => {
    setSessionPrincipal(c, principal(userId, permissions))
    await next()
  })
  mountConnectionsRoutes(userApp, { pools, crypto, invalidate })
  return userApp
}

beforeEach(async () => {
  invalidate.mockReset()
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await pools.rw.query(
    `INSERT INTO auth_users (id, email, display_name, signature_name, status, deleted_at)
     VALUES ($1, 'allowed@example.com', '許可ユーザー', '許可ユーザー', 'active', NULL),
            ($2, 'other@example.com', 'その他ユーザー', 'その他ユーザー', 'active', NULL)
     ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, status = 'active'`,
    [ALLOWED_USER_ID, OTHER_USER_ID],
  )
})
afterAll(() => closePools(pools))

interface MaskedConnection {
  id: string
  name: string
  endpoint: string
  region: string
  accessKeyIdMasked: string
  forcePathStyle: boolean
  listObjectsVersion: 'v1' | 'v2'
  isDefault: boolean
  visibility: {
    mode: 'public' | 'whitelist'
    allowedUsers: Array<{ id: string; displayName: string }>
  }
  capabilities: Record<string, boolean>
  capacityMetricsEnabled: boolean
  scanPageSize: number
  capacityTracking: { enabled: boolean; intervalSeconds: number }
  createdAt: string
  updatedAt: string
}

interface DbRow {
  id: string
  access_key_id_enc: string
  secret_access_key_enc: string
  access_key_id_masked: string
}

async function createOne(overrides: Partial<{
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  listObjectsVersion: 'v1' | 'v2'
  capabilities: Record<string, boolean>
  visibility: { mode: 'public' | 'whitelist'; allowedUserIds: string[] }
}> = {}): Promise<MaskedConnection> {
  const body: Record<string, unknown> = {
    name: overrides.name ?? 'primary',
    endpoint: overrides.endpoint ?? 'https://s3.example.com/',
    region: overrides.region ?? 'auto',
    accessKeyId: overrides.accessKeyId ?? 'AKIAEXAMPLE12345',
    secretAccessKey: overrides.secretAccessKey ?? 'super-secret-value-9999',
    forcePathStyle: overrides.forcePathStyle ?? true,
  }
  if (overrides.listObjectsVersion !== undefined) {
    body.listObjectsVersion = overrides.listObjectsVersion
  }
  if (overrides.capabilities !== undefined) {
    body.capabilities = overrides.capabilities
  }
  if (overrides.visibility !== undefined) {
    body.visibility = overrides.visibility
  }
  const res = await app.request('/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as MaskedConnection
}

describe('GET /connections', () => {
  it('接続が無ければ [] を返す', async () => {
    const res = await app.request('/connections')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST した接続をマスク済みの形で返す', async () => {
    const created = await createOne()
    const res = await app.request('/connections')
    expect(res.status).toBe(200)
    const list = (await res.json()) as MaskedConnection[]
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(created)
    // サニティチェック: レスポンスに平文の認証情報が含まれていないことを確認。
    const dump = JSON.stringify(list[0])
    expect(dump).not.toContain('super-secret-value-9999')
    expect(dump).not.toContain('AKIAEXAMPLE12345')
  })

  it('通常接続は全員、ホワイトリスト接続は許可ユーザーと管理者だけに返す', async () => {
    const publicConn = await createOne({ name: 'public' })
    const privateConn = await createOne({
      name: 'private',
      visibility: { mode: 'whitelist', allowedUserIds: [ALLOWED_USER_ID] },
    })

    const allowed = await (await appFor(ALLOWED_USER_ID).request('/connections')).json() as MaskedConnection[]
    expect(allowed.map(row => row.id).sort()).toEqual([privateConn.id, publicConn.id].sort())
    expect(allowed.find(row => row.id === privateConn.id)?.visibility.allowedUsers).toEqual([])

    const other = await (await appFor(OTHER_USER_ID).request('/connections')).json() as MaskedConnection[]
    expect(other.map(row => row.id)).toEqual([publicConn.id])

    const manager = await (await appFor(OTHER_USER_ID, ['connections:manage'])
      .request('/connections')).json() as MaskedConnection[]
    expect(manager.map(row => row.id).sort()).toEqual([privateConn.id, publicConn.id].sort())
    expect(manager.find(row => row.id === privateConn.id)?.visibility.allowedUsers)
      .toMatchObject([{ id: ALLOWED_USER_ID }])
  })

  it('非許可ユーザーのURL直打ちは存在を隠して404にする', async () => {
    const privateConn = await createOne({
      name: 'private',
      visibility: { mode: 'whitelist', allowedUserIds: [ALLOWED_USER_ID] },
    })
    const guarded = new Hono()
    guarded.use('*', async (c, next) => {
      setSessionPrincipal(c, principal(OTHER_USER_ID))
      await next()
    })
    guarded.use('/storage/:connectionId/*', requireConnectionAccess(pools.ro))
    guarded.get('/storage/:connectionId/buckets', c => c.json({ ok: true }))

    expect((await guarded.request(`/storage/${privateConn.id}/buckets`)).status).toBe(404)
  })
})

describe('POST /connections', () => {
  it('作成すると 200 で、10 文字の id を持つマスク済みの接続を返す', async () => {
    const created = await createOne()
    expect(created.id).toHaveLength(10)
    expect(created.name).toBe('primary')
    expect(created.endpoint).toBe('https://s3.example.com/')
    expect(created.region).toBe('auto')
    expect(created.accessKeyIdMasked).toBe('AKIA…2345')
    expect(created.forcePathStyle).toBe(true)
    // 既定値は 'v2' (AWS / R2 / MinIO 等の新しい実装向け)。
    expect(created.listObjectsVersion).toBe('v2')
    expect(created.visibility).toEqual({ mode: 'public', allowedUsers: [] })
    expect(created.capacityMetricsEnabled).toBe(true)
    expect(created.scanPageSize).toBe(1000)
    expect(created.capacityTracking).toEqual({ enabled: false, intervalSeconds: 86400 })
    expect(typeof created.createdAt).toBe('string')
    expect(typeof created.updatedAt).toBe('string')
    // 平文フィールドはレスポンスに含まれてはならない。
    const dump = JSON.stringify(created)
    expect(dump).not.toContain('super-secret-value-9999')
    expect(dump).not.toContain('AKIAEXAMPLE12345')
  })

  it('認証情報は DB に暗号化して保存し、マスクは正しい形になる', async () => {
    const created = await createOne()
    const r = await pools.rw.query<DbRow>(
      `SELECT id, access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`,
      [created.id],
    )
    expect(r.rows).toHaveLength(1)
    const row = r.rows[0]
    // 暗号化カラムは平文を含んではならない。
    expect(row.access_key_id_enc).not.toContain('AKIAEXAMPLE12345')
    expect(row.secret_access_key_enc).not.toContain('super-secret-value-9999')
    // パック済み暗号文 (v1:iv:tag:ct) であること。
    expect(row.access_key_id_enc.startsWith('v1:')).toBe(true)
    expect(row.secret_access_key_enc.startsWith('v1:')).toBe(true)
    // 復号すると元の値が復元される (ストレージパスのサニティチェック)。
    expect(crypto.decrypt(row.access_key_id_enc)).toBe('AKIAEXAMPLE12345')
    expect(crypto.decrypt(row.secret_access_key_enc)).toBe('super-secret-value-9999')
    // マスク済みカラムがルートの返した値と一致する。
    expect(row.access_key_id_masked).toBe('AKIA…2345')
  })

  it('必須項目が欠けた body は 400', async () => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }), // missing endpoint, accessKeyId, secretAccessKey
    })
    expect(res.status).toBe(400)
  })

  it('URL でないエンドポイントは 400', async () => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'x', endpoint: 'not-a-url',
        accessKeyId: 'a', secretAccessKey: 'b',
      }),
    })
    expect(res.status).toBe(400)
  })

  it.each([
    ['cloud metadata',   'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 loopback',    'http://127.0.0.1/'],
    ['localhost',        'http://localhost:9000/'],
    ['unspecified IPv4', 'http://0.0.0.0/'],
    ['IPv6 loopback',    'http://[::1]:9000/'],
    ['IPv6 link-local',  'http://[fe80::1]:9000/'],
  ])('%s へ向くエンドポイントは 400 (SSRF 対策)', async (_label, endpoint) => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ssrf-${Math.random().toString(36).slice(2, 8)}`,
        endpoint,
        accessKeyId: 'a', secretAccessKey: 'b',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('listObjectsVersion=v1 を受け付け、GET でそのまま返す', async () => {
    // V1 only の S3 互換サーバ のために v1 を明示できる。
    const created = await createOne({ name: 'legacy-v1-storage', listObjectsVersion: 'v1' })
    expect(created.listObjectsVersion).toBe('v1')

    const res = await app.request('/connections')
    const list = (await res.json()) as MaskedConnection[]
    const got = list.find(c => c.name === 'legacy-v1-storage')
    expect(got?.listObjectsVersion).toBe('v1')
  })

  it('不正な listObjectsVersion は拒否する', async () => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bogus',
        endpoint: 'https://s3.example.com/',
        accessKeyId: 'a', secretAccessKey: 'b',
        listObjectsVersion: 'v3',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('同じ名前で作ると 409', async () => {
    await createOne({ name: 'dup' })
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'dup', endpoint: 'https://s3.example.com/',
        accessKeyId: 'a', secretAccessKey: 'b',
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/already exists/)
  })
})

describe('PUT /connections/:id', () => {
  it('同じ内容の再保存ではcacheを破棄しない', async () => {
    const created = await createOne()
    invalidate.mockClear()
    const res = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: created.name,
        endpoint: created.endpoint,
        region: created.region,
        forcePathStyle: created.forcePathStyle,
        listObjectsVersion: created.listObjectsVersion,
      }),
    })
    expect(res.status).toBe(200)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('同じ認証情報の再保存では暗号文とcacheを変更しない', async () => {
    const created = await createOne()
    const before = await pools.rw.query<DbRow>(
      `SELECT id, access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`, [created.id],
    )
    invalidate.mockClear()
    const res = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessKeyId: 'AKIAEXAMPLE12345', secretAccessKey: 'super-secret-value-9999',
      }),
    })
    expect(res.status).toBe(200)
    const after = await pools.rw.query<DbRow>(
      `SELECT id, access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`, [created.id],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('名前だけ更新すると、更新後の接続を返し、DB の暗号化済み認証情報は変わらない', async () => {
    const created = await createOne()
    const before = await pools.rw.query<DbRow>(
      `SELECT id, access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`,
      [created.id],
    )

    const res = await app.request(`/connections/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MaskedConnection
    expect(updated.name).toBe('renamed')
    expect(updated.id).toBe(created.id)

    // 暗号化カラムとマスクは変更されていないはず。
    const after = await pools.rw.query<DbRow>(
      `SELECT id, access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`,
      [created.id],
    )
    expect(after.rows[0].access_key_id_enc).toBe(before.rows[0].access_key_id_enc)
    expect(after.rows[0].secret_access_key_enc).toBe(before.rows[0].secret_access_key_enc)
    expect(after.rows[0].access_key_id_masked).toBe(before.rows[0].access_key_id_masked)

    expect(invalidate).toHaveBeenCalledWith(created.id)
  })

  it('accessKeyId と secret を更新すると、DB の暗号文とマスクが変わる', async () => {
    const created = await createOne()
    const before = await pools.rw.query<DbRow>(
      `SELECT access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`,
      [created.id],
    )

    const res = await app.request(`/connections/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessKeyId: 'AKIANEWVALUE0001',
        secretAccessKey: 'brand-new-secret-value',
      }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MaskedConnection
    expect(updated.accessKeyIdMasked).toBe('AKIA…0001')

    const after = await pools.rw.query<DbRow>(
      `SELECT access_key_id_enc, secret_access_key_enc, access_key_id_masked
         FROM storage_connections WHERE id = $1`,
      [created.id],
    )
    // 両方の暗号化値が変更されているはず。
    expect(after.rows[0].access_key_id_enc)
      .not.toBe(before.rows[0].access_key_id_enc)
    expect(after.rows[0].secret_access_key_enc)
      .not.toBe(before.rows[0].secret_access_key_enc)
    // 復号サニティチェック。
    expect(crypto.decrypt(after.rows[0].access_key_id_enc)).toBe('AKIANEWVALUE0001')
    expect(crypto.decrypt(after.rows[0].secret_access_key_enc)).toBe('brand-new-secret-value')
    expect(after.rows[0].access_key_id_masked).toBe('AKIA…0001')

    expect(invalidate).toHaveBeenCalledWith(created.id)
  })

  it('空の body なら現在の接続をそのまま返し、更新も invalidate もしない', async () => {
    const created = await createOne()
    const res = await app.request(`/connections/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const got = (await res.json()) as MaskedConnection
    expect(got.id).toBe(created.id)
    expect(got.name).toBe(created.name)
    expect(got.accessKeyIdMasked).toBe(created.accessKeyIdMasked)
    // No-op: 何も変更されなかった場合 invalidate は呼ばれてはならない。
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('全bucketの容量計測設定をconnection単位で保存する', async () => {
    const created = await createOne()
    const response = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacityTracking: { enabled: true, intervalSeconds: 43200 } }),
    })
    expect(response.status).toBe(200)
    expect((await response.json() as MaskedConnection).capacityTracking)
      .toEqual({ enabled: true, intervalSeconds: 43200 })
    const stored = await pools.ro.query(
      `SELECT enabled, interval_seconds FROM storage_capacity_settings WHERE connection_id = $1`,
      [created.id],
    )
    expect(stored.rows).toEqual([{ enabled: true, interval_seconds: 43200 }])

    invalidate.mockReset()
    const same = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacityTracking: { enabled: true, intervalSeconds: 43200 } }),
    })
    expect(same.status).toBe(200)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('走査無効のconnectionでは容量の定期計測を有効にできない', async () => {
    const created = await createOne()
    const response = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scanEnabled: false,
        capacityTracking: { enabled: true, intervalSeconds: 86400 },
      }),
    })
    expect(response.status).toBe(400)
  })

  it('バケットのメトリクス集計を無効化でき、定期計測との矛盾は拒否する', async () => {
    const created = await createOne()
    const disabled = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacityMetricsEnabled: false }),
    })
    expect(disabled.status).toBe(200)
    expect((await disabled.json() as MaskedConnection).capacityMetricsEnabled).toBe(false)

    const invalid = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacityTracking: { enabled: true, intervalSeconds: 86400 } }),
    })
    expect(invalid.status).toBe(400)
  })

  it('走査ページサイズを保存し、許可していない値を拒否する', async () => {
    const created = await createOne()
    const updated = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanPageSize: 100 }),
    })
    expect(updated.status).toBe(200)
    expect((await updated.json() as MaskedConnection).scanPageSize).toBe(100)

    const invalid = await app.request(`/connections/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scanPageSize: 123 }),
    })
    expect(invalid.status).toBe(400)
  })

  it('listObjectsVersion を v2 → v1 → v2 と切り替えられる', async () => {
    const created = await createOne()
    expect(created.listObjectsVersion).toBe('v2')

    // v1 へ切替
    let res = await app.request(`/connections/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listObjectsVersion: 'v1' }),
    })
    expect(res.status).toBe(200)
    let updated = (await res.json()) as MaskedConnection
    expect(updated.listObjectsVersion).toBe('v1')
    expect(invalidate).toHaveBeenCalledWith(created.id)

    // v2 へ戻す
    res = await app.request(`/connections/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listObjectsVersion: 'v2' }),
    })
    expect(res.status).toBe(200)
    updated = (await res.json()) as MaskedConnection
    expect(updated.listObjectsVersion).toBe('v2')
  })

  it('存在しない id は 404', async () => {
    const res = await app.request('/connections/doesnotexist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'whatever' }),
    })
    expect(res.status).toBe(404)
  })

})

describe('DELETE /connections/:id', () => {
  it('削除すると行が消え、invalidate が呼ばれる', async () => {
    const created = await createOne()
    const res = await app.request(`/connections/${created.id}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const r = await pools.rw.query('SELECT count(*) FROM storage_connections WHERE id = $1', [created.id])
    expect(r.rows[0].count).toBe('0')
    expect(invalidate).toHaveBeenCalledWith(created.id)
  })

  it('存在しない id は 404', async () => {
    const res = await app.request('/connections/doesnotexist', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('デフォルト接続', () => {
  it('GET /connections は isDefault を返す (初期は全て false)', async () => {
    await createOne({ name: 'connection-a' })
    await createOne({ name: 'connection-b' })
    const res = await app.request('/connections')
    const list = (await res.json()) as MaskedConnection[]
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.every(c => c.isDefault === false)).toBe(true)
  })

  it('PUT /:id/default で切り替わり、常に 1 件だけ true', async () => {
    const a = await createOne({ name: 'connection-a' })
    const b = await createOne({ name: 'connection-b' })

    let res = await app.request(`/connections/${a.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    let after = (await (await app.request('/connections')).json()) as MaskedConnection[]
    expect(after.filter(c => c.isDefault).map(c => c.id)).toEqual([a.id])

    res = await app.request(`/connections/${b.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)
    after = (await (await app.request('/connections')).json()) as MaskedConnection[]
    expect(after.filter(c => c.isDefault).map(c => c.id)).toEqual([b.id])
  })

  it('既にデフォルトの id への PUT は冪等 (200 でデフォルトはその 1 件のまま)', async () => {
    const a = await createOne({ name: 'connection-a' })
    await createOne({ name: 'connection-b' })

    let res = await app.request(`/connections/${a.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)

    // 同じ id にもう一度 PUT しても 200 で、デフォルトは a の 1 件のまま。
    res = await app.request(`/connections/${a.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const after = (await (await app.request('/connections')).json()) as MaskedConnection[]
    expect(after.filter(c => c.isDefault).map(c => c.id)).toEqual([a.id])
  })

  it('存在しない id は 404', async () => {
    const res = await app.request('/connections/nonexistent1/default', { method: 'PUT' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('connection not found')
  })
})

describe('接続ごとの権限 (capabilities)', () => {
  const ALL = [
    'list', 'preview', 'download', 'archive',
    'audioInfo', 'audioSpectrogram', 'readmeRead', 'readmeWrite',
  ]

  it('省略して作るとすべて有効 (マイグレーション前と同じ挙動)', async () => {
    const connection = await createOne()
    expect(Object.keys(connection.capabilities).sort()).toEqual([...ALL].sort())
    expect(Object.values(connection.capabilities).every(Boolean)).toBe(true)
  })

  it('作成時に一部だけ落とせる (指定しなかったキーは有効のまま)', async () => {
    const connection = await createOne({
      capabilities: { download: false, archive: false },
    })
    expect(connection.capabilities.download).toBe(false)
    expect(connection.capabilities.archive).toBe(false)
    expect(connection.capabilities.list).toBe(true)
    expect(connection.capabilities.preview).toBe(true)
  })

  it('PUT は差分更新 — 送ったキーだけ変わる', async () => {
    const connection = await createOne()
    const res = await app.request(`/connections/${connection.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { download: false } }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MaskedConnection
    expect(updated.capabilities.download).toBe(false)
    expect(updated.capabilities.audioInfo).toBe(true)
    // 権限を変えたら S3Client キャッシュを捨てて次回リクエストで反映させる。
    expect(invalidate).toHaveBeenCalledWith(connection.id)
  })

  it('README 編集だけ有効にして作ると 400 (編集には読み込みが必要)', async () => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad', endpoint: 'https://s3.example.com/',
        accessKeyId: 'AKIAEXAMPLE12345', secretAccessKey: 'super-secret-value-9999',
        capabilities: { readmeRead: false, readmeWrite: true },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('編集を有効にしたまま読み込みだけ落とす PUT は 400', async () => {
    const connection = await createOne()
    const res = await app.request(`/connections/${connection.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { readmeRead: false } }),
    })
    expect(res.status).toBe(400)
    // 拒否された更新は DB に反映されない。
    const after = (await (await app.request('/connections')).json()) as MaskedConnection[]
    expect(after[0].capabilities.readmeRead).toBe(true)
  })

  it('読み込みと編集を同時に落とすのは通る', async () => {
    const connection = await createOne()
    const res = await app.request(`/connections/${connection.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { readmeRead: false, readmeWrite: false } }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MaskedConnection
    expect(updated.capabilities.readmeRead).toBe(false)
    expect(updated.capabilities.readmeWrite).toBe(false)
  })
})

describe('connection_settings に行が無い接続 (マイグレーション前からある接続)', () => {
  it('権限行が 1 つも無ければ全権限が有効として返る', async () => {
    // 013 適用前から居る接続を再現する — connection_settings には何も入れない。
    await pools.rw.query(
      `INSERT INTO storage_connections
         (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked)
       VALUES ('legacy0001', 'legacy', 'https://s3.example.com/', 'auto', 'v1:x', 'v1:y', 'AKIA…0000')`,
    )
    const list = (await (await app.request('/connections')).json()) as MaskedConnection[]
    const legacy = list.find(c => c.id === 'legacy0001')
    expect(legacy).toBeDefined()
    expect(Object.values(legacy!.capabilities).every(Boolean)).toBe(true)
  })

  it('権限を落とすと connection_settings に cap.* の行として入る', async () => {
    const connection = await createOne({ capabilities: { download: false } })
    const r = await pools.ro.query<{ key: string; value: string }>(
      `SELECT key, value FROM connection_settings WHERE connection_id = $1 AND key = 'cap.download'`,
      [connection.id],
    )
    expect(r.rows).toEqual([{ key: 'cap.download', value: 'false' }])
  })

  it('接続を消すと権限行も連鎖削除される', async () => {
    const connection = await createOne({ capabilities: { download: false } })
    await app.request(`/connections/${connection.id}`, { method: 'DELETE' })
    const r = await pools.ro.query(
      `SELECT 1 FROM connection_settings WHERE connection_id = $1`, [connection.id],
    )
    expect(r.rowCount).toBe(0)
  })
})
