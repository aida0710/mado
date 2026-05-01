import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageReadmeRoutes } from './storage-readme.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const getStorage = async (): Promise<S3Client> => storage

const TEST_CONN_ID = 'testconn01'

async function seedConnection(p: Pools, id: string): Promise<void> {
  await p.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, 'https://test.example/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…XYZ4', true)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

const app = new Hono()
mountStorageReadmeRoutes(app, { getStorage, pools })

beforeEach(async () => {
  storageMock.reset()
  // CASCADE clears storage_readme_meta along with the connection seed.
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await seedConnection(pools, TEST_CONN_ID)
})
afterAll(() => closePools(pools))

describe('GET /api/storage/:connId/readme', () => {
  it('returns body and meta when README exists', async () => {
    storageMock.on(GetObjectCommand, { Bucket: 'b', Key: 'voice/jp/README.md' })
      .resolves({
        Body: Readable.from(Buffer.from('# Voice JP\nhello')) as never,
      })
    await pools.rw.query(
      `INSERT INTO storage_readme_meta(connection_id, bucket, prefix, last_editor, size_bytes)
       VALUES($1,'b','voice/jp/','tanaka',16)`,
      [TEST_CONN_ID],
    )
    const res = await app.request(
      `/api/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=voice/jp/`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      exists: true; body: string; last_editor: string | null
    }
    expect(body.exists).toBe(true)
    expect(body.body).toBe('# Voice JP\nhello')
    expect(body.last_editor).toBe('tanaka')
  })

  it('returns exists:false when README is absent', async () => {
    storageMock.on(GetObjectCommand).rejects(
      new NoSuchKey({ message: 'no', $metadata: {} })
    )
    const res = await app.request(
      `/api/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=missing/`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
  })

  it('handles bucket root (empty prefix)', async () => {
    storageMock.on(GetObjectCommand, { Bucket: 'b', Key: 'README.md' })
      .resolves({
        Body: Readable.from(Buffer.from('root')) as never,
      })
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exists: true; body: string }
    expect(body.body).toBe('root')
  })

  it('400 when bucket missing', async () => {
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`)
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/storage/:connId/readme', () => {
  it('uploads body and upserts meta', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'new body', editor: 'sato',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: true; size_bytes: number }
    expect(body.ok).toBe(true)
    expect(body.size_bytes).toBe(Buffer.byteLength('new body', 'utf-8'))

    // Storage PUT was called with the right key + content-type
    const calls = storageMock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'voice/jp/README.md',
      ContentType: 'text/markdown',
    })

    // DB row was inserted (with the connection_id).
    const r = await pools.rw.query(
      'SELECT connection_id, bucket, prefix, last_editor, size_bytes FROM storage_readme_meta'
    )
    expect(r.rows).toEqual([
      {
        connection_id: TEST_CONN_ID,
        bucket: 'b', prefix: 'voice/jp/', last_editor: 'sato', size_bytes: 8,
      },
    ])
  })

  it('upserts (overwrites) the existing meta row', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    await pools.rw.query(
      `INSERT INTO storage_readme_meta(connection_id, bucket, prefix, last_editor, size_bytes)
       VALUES($1,'b','voice/jp/','tanaka',5)`,
      [TEST_CONN_ID],
    )
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'newer', editor: 'sato',
      }),
    })
    expect(res.status).toBe(200)
    const r = await pools.rw.query(
      'SELECT last_editor, size_bytes FROM storage_readme_meta'
    )
    expect(r.rows).toEqual([{ last_editor: 'sato', size_bytes: 5 }])
  })

  it('does NOT touch DB when storage PUT fails (atomicity)', async () => {
    storageMock.on(PutObjectCommand).rejects(new Error('storage down'))
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: 'b', prefix: 'voice/jp/', body: 'new', editor: 'sato',
      }),
    })
    expect(res.status).toBe(500)
    const r = await pools.rw.query('SELECT count(*) FROM storage_readme_meta')
    expect(r.rows[0].count).toBe('0')
  })

  it('400 on malformed JSON body', async () => {
    const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b' }), // missing prefix, body, editor
    })
    expect(res.status).toBe(400)
  })

  it('returns ok+meta_stale when DB write fails after storage PUT succeeds', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    // Force the DB write to fail by referencing a non-existent prefix path
    // through a constraint violation. The simplest reliable way: poison the
    // pool with a query that errors. Use a sentinel `editor` value that we
    // pre-fail by wrapping `pools.rw.query` once; but since this test stays
    // black-box, force failure by passing prefix > permissible by an
    // ad-hoc CHECK we add via a one-shot SQL preface.
    await pools.rw.query(
      `ALTER TABLE storage_readme_meta ADD CONSTRAINT temp_no_z
         CHECK (last_editor <> 'POISON')`
    )
    try {
      const res = await app.request(`/api/storage/${TEST_CONN_ID}/readme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: 'b', prefix: 'a/', body: 'x', editor: 'POISON',
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: true; meta_stale: true; size_bytes: number
      }
      expect(body.ok).toBe(true)
      expect(body.meta_stale).toBe(true)
      expect(body.size_bytes).toBe(1)
      // Storage PUT did happen
      expect(storageMock.commandCalls(PutObjectCommand)).toHaveLength(1)
      // DB row stayed empty
      const r = await pools.rw.query('SELECT count(*) FROM storage_readme_meta')
      expect(r.rows[0].count).toBe('0')
    } finally {
      await pools.rw.query(
        `ALTER TABLE storage_readme_meta DROP CONSTRAINT IF EXISTS temp_no_z`
      )
    }
  })
})

describe('connection-not-found behaviour', () => {
  it('GET returns 404 when connId does not exist via factory', async () => {
    // Bypass the test's local fake getStorage by mounting a fresh app whose
    // factory throws ConnectionNotFoundError.
    const { ConnectionNotFoundError } = await import('../storage.js')
    const localApp = new Hono()
    mountStorageReadmeRoutes(localApp, {
      getStorage: async (id: string) => { throw new ConnectionNotFoundError(id) },
      pools,
    })
    const res = await localApp.request('/api/storage/missing0001/readme?bucket=b')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'connection not found' })
  })
})
