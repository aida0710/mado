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
  // CASCADE で接続シードと一緒に storage_readme_meta もクリアされる。
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await seedConnection(pools, TEST_CONN_ID)
})
afterAll(() => closePools(pools))

describe('GET /storage/:connId/readme', () => {
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
      `/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=voice/jp/`,
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
      `/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=missing/`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
  })

  it('handles bucket root (empty prefix)', async () => {
    storageMock.on(GetObjectCommand, { Bucket: 'b', Key: 'README.md' })
      .resolves({
        Body: Readable.from(Buffer.from('root')) as never,
      })
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme?bucket=b&prefix=`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exists: true; body: string }
    expect(body.body).toBe('root')
  })

  it('400 when bucket missing', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme`)
    expect(res.status).toBe(400)
  })
})

describe('PUT /storage/:connId/readme', () => {
  it('uploads body and upserts meta', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme`, {
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

    // Storage PUT が正しいキーと content-type で呼ばれたか確認する
    const calls = storageMock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'voice/jp/README.md',
      ContentType: 'text/markdown',
    })

    // DB 行が挿入されたか確認する (connection_id 付き)。
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
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme`, {
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
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme`, {
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
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b' }), // missing prefix, body, editor
    })
    expect(res.status).toBe(400)
  })

  it('returns ok+meta_stale when DB write fails after storage PUT succeeds', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    // 制約違反でDB書き込みを失敗させる。最も信頼性の高い方法: プールをエラーを起こす
    // クエリで毒見させる。sentinel `editor` 値を用いて `pools.rw.query` を一度
    // ラップして事前失敗させる方法もあるが、このテストはブラックボックスのまま維持するため、
    // アドホックな CHECK 制約を一時的に追加してプレフィックスを拒否させる。
    await pools.rw.query(
      `ALTER TABLE storage_readme_meta ADD CONSTRAINT temp_no_z
         CHECK (last_editor <> 'POISON')`
    )
    try {
      const res = await app.request(`/storage/${TEST_CONN_ID}/readme`, {
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
      // Storage PUT は実行されたはず
      expect(storageMock.commandCalls(PutObjectCommand)).toHaveLength(1)
      // DB 行は空のまま
      const r = await pools.rw.query('SELECT count(*) FROM storage_readme_meta')
      expect(r.rows[0].count).toBe('0')
    } finally {
      await pools.rw.query(
        `ALTER TABLE storage_readme_meta DROP CONSTRAINT IF EXISTS temp_no_z`
      )
    }
  })
})

describe('PUT /storage/:connId/readme — 履歴記録', () => {
  it('PUT 成功時に storage_readme_history へ INSERT される (path 単位で append)', async () => {
    storageMock.on(PutObjectCommand).resolves({})
    // 同じ path で 2 回 PUT
    await app.request(`/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'p/', body: 'v1', editor: 'tanaka' }),
    })
    await app.request(`/storage/${TEST_CONN_ID}/readme`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'p/', body: 'v2 updated', editor: 'sato' }),
    })
    const r = await pools.rw.query(
      `SELECT body, editor, size_bytes FROM storage_readme_history
         WHERE connection_id=$1 AND bucket='b' AND prefix='p/' ORDER BY edited_at`,
      [TEST_CONN_ID],
    )
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]).toMatchObject({ body: 'v1', editor: 'tanaka', size_bytes: 2 })
    expect(r.rows[1]).toMatchObject({ body: 'v2 updated', editor: 'sato', size_bytes: 10 })
  })
})

describe('GET /storage/:connId/readme/history', () => {
  beforeEach(async () => {
    // 履歴を 3 件投入 (時系列で降順に取れることを確認)
    for (const [body, editor] of [['v1', 'a'], ['v2', 'b'], ['v3', 'a']] as const) {
      await pools.rw.query(
        `INSERT INTO storage_readme_history(connection_id, bucket, prefix, body, size_bytes, editor)
         VALUES($1, 'b', 'p/', $2, $3, $4)`,
        [TEST_CONN_ID, body, body.length, editor],
      )
    }
  })

  it('versions を edited_at DESC で返す', async () => {
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/readme/history?bucket=b&prefix=p/`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { versions: Array<{ editor: string; size_bytes: number; id: number }> }
    expect(json.versions.length).toBe(3)
    // 最新 = v3 (editor 'a')
    expect(json.versions[0].editor).toBe('a')
    expect(json.versions[0].size_bytes).toBe(2)
    // 2 番目 = v2
    expect(json.versions[1].editor).toBe('b')
  })

  it('limit でページサイズを制限できる', async () => {
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/readme/history?bucket=b&prefix=p/&limit=2`,
    )
    const json = (await res.json()) as { versions: unknown[] }
    expect(json.versions.length).toBe(2)
  })

  it('該当無しは空配列', async () => {
    const res = await app.request(
      `/storage/${TEST_CONN_ID}/readme/history?bucket=b&prefix=other/`,
    )
    const json = (await res.json()) as { versions: unknown[] }
    expect(json.versions).toEqual([])
  })

  it('bucket 未指定で 400', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme/history`)
    expect(res.status).toBe(400)
  })
})

describe('GET /storage/:connId/readme/history/:id', () => {
  it('特定版の body と meta を返す', async () => {
    const ins = await pools.rw.query<{ id: string }>(
      `INSERT INTO storage_readme_history(connection_id, bucket, prefix, body, size_bytes, editor)
       VALUES($1, 'b', 'p/', '# v42', 5, 'tanaka')
       RETURNING id`,
      [TEST_CONN_ID],
    )
    const id = ins.rows[0].id
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme/history/${id}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { body: string; editor: string; bucket: string; prefix: string }
    expect(json).toMatchObject({ body: '# v42', editor: 'tanaka', bucket: 'b', prefix: 'p/' })
  })

  it('id 未存在で 404', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme/history/999999999`)
    expect(res.status).toBe(404)
  })

  it('id が数字でない場合 400', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/readme/history/abc`)
    expect(res.status).toBe(400)
  })
})

describe('GET /storage/:connId/readmes/search', () => {
  beforeEach(async () => {
    // 同じ path で 2 版 (古い版にだけ "古い" あり)、別 path に "find me"
    await pools.rw.query(
      `INSERT INTO storage_readme_history(connection_id, bucket, prefix, body, size_bytes, editor) VALUES
        ($1, 'b', 'p1/', '古い記述だけ',  18, 'a'),
        ($1, 'b', 'p1/', '新しい記述',     12, 'a'),
        ($1, 'b', 'p2/', 'find me here',  12, 'b')`,
      [TEST_CONN_ID],
    )
  })

  it('現在版 (DISTINCT ON 最新) のみを対象に LIKE 検索', async () => {
    // p1 の最新版には "古い" は無い → ヒット 0
    const r1 = await app.request(`/storage/${TEST_CONN_ID}/readmes/search?q=${encodeURIComponent('古い')}`)
    const j1 = (await r1.json()) as { hits: unknown[] }
    expect(j1.hits).toEqual([])
    // p2 で "find" にヒット
    const r2 = await app.request(`/storage/${TEST_CONN_ID}/readmes/search?q=find`)
    const j2 = (await r2.json()) as { hits: Array<{ bucket: string; prefix: string }> }
    expect(j2.hits.length).toBe(1)
    expect(j2.hits[0]).toMatchObject({ bucket: 'b', prefix: 'p2/' })
  })

  it('q が 1 文字以下で 400', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/readmes/search?q=x`)
    expect(res.status).toBe(400)
  })
})

describe('connection-not-found behaviour', () => {
  it('GET returns 404 when connId does not exist via factory', async () => {
    // テストのローカルフェイク getStorage をバイパスするため、
    // ConnectionNotFoundError を投げるファクトリを持つ新しいアプリをマウントする。
    const { ConnectionNotFoundError } = await import('../storage.js')
    const localApp = new Hono()
    mountStorageReadmeRoutes(localApp, {
      getStorage: async (id: string) => { throw new ConnectionNotFoundError(id) },
      pools,
    })
    const res = await localApp.request('/storage/missing0001/readme?bucket=b')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'connection not found' })
  })
})
