import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createCrypto } from '../crypto.js'
import { mountConnectionsRoutes } from './connections.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const TEST_KEY = 'a'.repeat(64)
const crypto = createCrypto(TEST_KEY)

const invalidate = vi.fn<(id: string) => void>()

const app = new Hono()
mountConnectionsRoutes(app, { pools, crypto, invalidate })

beforeEach(async () => {
  invalidate.mockReset()
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
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
  capabilities: Record<string, boolean>
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
  const res = await app.request('/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as MaskedConnection
}

describe('GET /connections', () => {
  it('returns [] when no connections exist', async () => {
    const res = await app.request('/connections')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns the masked record after a POST', async () => {
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
})

describe('POST /connections', () => {
  it('creates a connection: 200, returns masked record (id is 10 chars)', async () => {
    const created = await createOne()
    expect(created.id).toHaveLength(10)
    expect(created.name).toBe('primary')
    expect(created.endpoint).toBe('https://s3.example.com/')
    expect(created.region).toBe('auto')
    expect(created.accessKeyIdMasked).toBe('AKIA…2345')
    expect(created.forcePathStyle).toBe(true)
    // 既定値は 'v2' (AWS / R2 / MinIO 等の新しい実装向け)。
    expect(created.listObjectsVersion).toBe('v2')
    expect(typeof created.createdAt).toBe('string')
    expect(typeof created.updatedAt).toBe('string')
    // 平文フィールドはレスポンスに含まれてはならない。
    const dump = JSON.stringify(created)
    expect(dump).not.toContain('super-secret-value-9999')
    expect(dump).not.toContain('AKIAEXAMPLE12345')
  })

  it('stores ENCRYPTED keys in DB (not plaintext) and stores correct mask', async () => {
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

  it('returns 400 on malformed body (missing required fields)', async () => {
    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }), // missing endpoint, accessKeyId, secretAccessKey
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 on non-URL endpoint', async () => {
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
  ])('returns 400 on SSRF-prone endpoint (%s)', async (_label, endpoint) => {
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

  it('accepts listObjectsVersion=v1 and round-trips it through GET', async () => {
    // V1 only の S3 互換サーバ のために v1 を明示できる。
    const created = await createOne({ name: 'legacy-v1-storage', listObjectsVersion: 'v1' })
    expect(created.listObjectsVersion).toBe('v1')

    const res = await app.request('/connections')
    const list = (await res.json()) as MaskedConnection[]
    const got = list.find(c => c.name === 'legacy-v1-storage')
    expect(got?.listObjectsVersion).toBe('v1')
  })

  it('rejects an invalid listObjectsVersion value', async () => {
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

  it('returns 409 on duplicate name', async () => {
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
  it('updates name only: returns updated record, encrypted keys unchanged in DB', async () => {
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

  it('updates accessKeyId+secret: encrypted values change in DB, mask updates', async () => {
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

  it('with empty body returns current record (no update, no invalidate)', async () => {
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

  it('updates listObjectsVersion v2 → v1 and back', async () => {
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

  it('returns 404 for non-existent id', async () => {
    const res = await app.request('/connections/doesnotexist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'whatever' }),
    })
    expect(res.status).toBe(404)
  })

})

describe('DELETE /connections/:id', () => {
  it('removes record and invokes invalidate', async () => {
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

  it('returns 404 for non-existent id', async () => {
    const res = await app.request('/connections/doesnotexist', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('default connection', () => {
  it('GET /connections は isDefault を返す (初期は全て false)', async () => {
    await createOne({ name: 'conn-a' })
    await createOne({ name: 'conn-b' })
    const res = await app.request('/connections')
    const list = (await res.json()) as MaskedConnection[]
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.every(c => c.isDefault === false)).toBe(true)
  })

  it('PUT /:id/default で切り替わり、常に 1 件だけ true', async () => {
    const a = await createOne({ name: 'conn-a' })
    const b = await createOne({ name: 'conn-b' })

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
    const a = await createOne({ name: 'conn-a' })
    await createOne({ name: 'conn-b' })

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
    const conn = await createOne()
    expect(Object.keys(conn.capabilities).sort()).toEqual([...ALL].sort())
    expect(Object.values(conn.capabilities).every(Boolean)).toBe(true)
  })

  it('作成時に一部だけ落とせる (指定しなかったキーは有効のまま)', async () => {
    const conn = await createOne({
      capabilities: { download: false, archive: false },
    })
    expect(conn.capabilities.download).toBe(false)
    expect(conn.capabilities.archive).toBe(false)
    expect(conn.capabilities.list).toBe(true)
    expect(conn.capabilities.preview).toBe(true)
  })

  it('PUT は差分更新 — 送ったキーだけ変わる', async () => {
    const conn = await createOne()
    const res = await app.request(`/connections/${conn.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { download: false } }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MaskedConnection
    expect(updated.capabilities.download).toBe(false)
    expect(updated.capabilities.audioInfo).toBe(true)
    // 権限を変えたら S3Client キャッシュを捨てて次回リクエストで反映させる。
    expect(invalidate).toHaveBeenCalledWith(conn.id)
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
    const conn = await createOne()
    const res = await app.request(`/connections/${conn.id}`, {
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
    const conn = await createOne()
    const res = await app.request(`/connections/${conn.id}`, {
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
    const conn = await createOne({ capabilities: { download: false } })
    const r = await pools.ro.query<{ key: string; value: string }>(
      `SELECT key, value FROM connection_settings WHERE connection_id = $1 AND key = 'cap.download'`,
      [conn.id],
    )
    expect(r.rows).toEqual([{ key: 'cap.download', value: 'false' }])
  })

  it('接続を消すと権限行も連鎖削除される', async () => {
    const conn = await createOne({ capabilities: { download: false } })
    await app.request(`/connections/${conn.id}`, { method: 'DELETE' })
    const r = await pools.ro.query(
      `SELECT 1 FROM connection_settings WHERE connection_id = $1`, [conn.id],
    )
    expect(r.rowCount).toBe(0)
  })
})
