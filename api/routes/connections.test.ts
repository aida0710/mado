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
}> = {}): Promise<MaskedConnection> {
  const body = {
    name: overrides.name ?? 'primary',
    endpoint: overrides.endpoint ?? 'https://s3.example.com/',
    region: overrides.region ?? 'auto',
    accessKeyId: overrides.accessKeyId ?? 'AKIAEXAMPLE12345',
    secretAccessKey: overrides.secretAccessKey ?? 'super-secret-value-9999',
    forcePathStyle: overrides.forcePathStyle ?? true,
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
