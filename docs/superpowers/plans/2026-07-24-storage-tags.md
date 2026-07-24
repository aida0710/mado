# バケット / ディレクトリ / ファイルへのタグ付け Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** バケット・ディレクトリ・ファイルに事前定義タグ (色付き) を付けられるようにし、一覧上のバッジ表示、一覧内絞り込み、同一接続内の全バケット横断検索、Settings でのタグ管理を実現する。

**Architecture:** README/favorites と同じ「S3 には書かず Postgres に LAN 共有メタデータとして保存」方式。`storage_tags` (タグレジストリ、全接続共通) と `storage_tag_assignments` (bucket/prefix/file を `target_kind` で判別する統合割り当てテーブル) の 2 テーブル。バックエンドは新規 `api/routes/storage-tags.ts` に registry CRUD・割り当て CRUD・横断検索の 3 グループを実装。フロントは新規プリミティブ (`TagBadge`, `TagPicker`, `TagFilterBar`, `TagSearchPanel`, `TagsSettings`) を作り、既存の `EntryTable` / `StorageBrowser` / `StorageIndex` / `ConnectionsPage` に組み込む。

**Tech Stack:** Hono (API ルーティング) / node-postgres (`pg`) / zod v4 (バリデーション・レスポンス parse) / React 18 + react-router-dom / Vitest + Testing Library。

## Global Constraints

- 認証なし・オナーシステム契約 (README/favorites と同じ) — write 系エンドポイントに独自の認証は追加しない。防御は `requireSafeOrigin` ミドルウェア (既存、`internal.ts` で `api.use('*', ...)` 済み) に委ねる。
- タグ名は 1〜32 文字、色は `^#[0-9a-fA-F]{6}$` の hex 文字列。
- 部分更新は `PATCH` ではなく `PUT` を使う (既存 `PUT /connections/:id` の規約に統一)。
- `target_kind` は `'bucket' | 'prefix' | 'file'` の 3 値。`kind: 'bucket'` のときは `path` を常に `''` に正規化する。
- 新しい DB テーブルは `db/migrations/010_storage_tags.sql` に追加し、末尾で `ALTER TABLE ... OWNER TO dashboard_rw` と `GRANT SELECT ... TO dashboard_ro` を明示する (`002_readme_history.sql` と同じ理由: マイグレーションは `postgres` ユーザで実行されるため `ALTER DEFAULT PRIVILEGES` の対象外)。
- API テストは `DATABASE_URL_RW_TEST` (既定 `postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test`) に対して実行する。実行前に `docker compose -f compose.dev.yaml up -d postgres` が必要 (既存の README 記載どおり)。
- フロントの新規 API クライアントメソッドは既存の `getJson` / `mutateJson` / `TTLCache` / `k()` ヘルパーを再利用する (`front/lib/api/client.ts`)。
- 既存コンポーネントのスタイル規約 (Tailwind ユーティリティ + 動的値のみ `style={{}}`、`.modal-backdrop`/`.modal`/`.modal-field`/`.modal-actions`/`.ghost`/`.error`/`.kicker` などの既存 CSS クラスを再利用) に従う。新しい CSS クラスは追加しない。

---

## Task 1: DB マイグレーション

**Files:**
- Create: `db/migrations/010_storage_tags.sql`

**Interfaces:**
- Produces: テーブル `storage_tags(id, name, color, created_at)`、`storage_tag_assignments(tag_id, connection_id, bucket, target_kind, target_path, created_at)`。以降の全タスクがこれに依存する。

- [ ] **Step 1: マイグレーションファイルを書く**

```sql
-- db/migrations/010_storage_tags.sql
-- 事前定義タグ + bucket/ディレクトリ/ファイルへの割り当て
-- (spec: docs/superpowers/specs/2026-07-24-storage-tags-design.md)

-- 事前定義タグのレジストリ。全接続共通 (connection_id を持たない)。
CREATE TABLE IF NOT EXISTS storage_tags (
  id         TEXT        PRIMARY KEY,        -- nanoid(10)
  name       TEXT        NOT NULL UNIQUE,
  color      TEXT        NOT NULL,            -- '#RRGGBB'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(name) BETWEEN 1 AND 32),
  CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  CHECK (length(id) = 10)
);

-- タグの割り当て。bucket 自体 / prefix (ディレクトリ) / file (key) の
-- 3種類の対象をひとつのテーブルで表現する (target_kind で判別)。
-- 種別ごとにテーブルを分けず統合することで、CRUD ロジックの重複を避ける。
CREATE TABLE IF NOT EXISTS storage_tag_assignments (
  tag_id        TEXT        NOT NULL REFERENCES storage_tags(id) ON DELETE CASCADE,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  target_kind   TEXT        NOT NULL CHECK (target_kind IN ('bucket','prefix','file')),
  target_path   TEXT        NOT NULL DEFAULT '',  -- bucket: '' / prefix: 'a/b/' / file: 'a/b/c.txt'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, target_kind, target_path, tag_id)
);

CREATE INDEX IF NOT EXISTS storage_tag_assignments_tag_idx
  ON storage_tag_assignments (tag_id);

-- 既存テーブルと同じく rw 所有 + ro SELECT。
ALTER TABLE storage_tags            OWNER TO dashboard_rw;
ALTER TABLE storage_tag_assignments OWNER TO dashboard_rw;
GRANT SELECT ON storage_tags, storage_tag_assignments TO dashboard_ro;
```

- [ ] **Step 2: dev DB に適用して確認する**

Run:
```bash
docker compose -f compose.dev.yaml up -d postgres
docker compose -f compose.dev.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 --username postgres --dbname dashboard \
  -f /migrations/010_storage_tags.sql
docker compose -f compose.dev.yaml exec -T postgres \
  psql --username postgres --dbname dashboard \
  -c "\d storage_tags" -c "\d storage_tag_assignments"
```
Expected: 両方の `\d` 出力にカラム定義・制約・インデックスが表示され、エラーなく完了する。

- [ ] **Step 3: テスト DB にも適用する (API テストが読みに行く DB)**

Run:
```bash
docker compose -f compose.dev.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 --username postgres --dbname dashboard_test \
  -f /migrations/010_storage_tags.sql
```
Expected: エラーなく完了する。

- [ ] **Step 4: Commit**

```bash
git add db/migrations/010_storage_tags.sql
git commit -m "feat(db): storage_tags / storage_tag_assignments テーブルを追加"
```

---

## Task 2: バックエンド — タグレジストリ CRUD

**Files:**
- Create: `api/routes/storage-tags.ts`
- Create: `api/routes/storage-tags.test.ts`
- Modify: `api/internal.ts`

**Interfaces:**
- Consumes: `Pools` (`api/db.ts`)、`storage_tags` テーブル (Task 1)。
- Produces: `mountStorageTagsRoutes(app: Hono, deps: StorageTagsDeps): void` で以下をマウント (この時点では registry のみ):
  - `GET /tags` → `[{ id, name, color }]`
  - `POST /tags` body `{ name, color }` → `{ id, name, color }` (201 ではなく既存規約どおり 200)
  - `PUT /tags/:id` body `{ name?, color? }` → `{ id, name, color }`
  - `DELETE /tags/:id` → `{ ok: true }`
  - `export interface StorageTagsDeps { pools: Pools }` — 後続タスクで拡張しない (S3 アクセス不要なので `getStorage` は持たない)。

- [ ] **Step 1: 失敗するテストを書く (registry CRUD)**

```typescript
// api/routes/storage-tags.test.ts
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageTagsRoutes } from './storage-tags.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountStorageTagsRoutes(app, { pools })

interface TagRow { id: string; name: string; color: string }

beforeEach(async () => {
  // CASCADE で storage_tag_assignments も消える。
  await pools.rw.query('TRUNCATE storage_tags CASCADE')
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
})
afterAll(() => closePools(pools))

async function seedConnection(p: Pools, id: string): Promise<void> {
  await p.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, 'https://test.example/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…XYZ4', true)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

describe('タグレジストリ', () => {
  it('GET /tags は空配列を返す (初期状態)', async () => {
    const res = await app.request('/tags')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST /tags で作成し、GET /tags に反映される', async () => {
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#ff0000' }),
    })
    expect(res.status).toBe(200)
    const created = await res.json() as TagRow
    expect(created.name).toBe('重要')
    expect(created.color).toBe('#ff0000')
    expect(created.id).toHaveLength(10)

    const list = await app.request('/tags')
    expect(await list.json()).toEqual([created])
  })

  it('POST /tags は name 重複を 409 で拒否する', async () => {
    await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#ff0000' }),
    })
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#00ff00' }),
    })
    expect(res.status).toBe(409)
  })

  it('POST /tags は不正な color を 400 で拒否する', async () => {
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', color: 'red' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT /tags/:id で name/color を部分更新できる', async () => {
    const created = await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', color: '#111111' }),
    })).json() as TagRow

    const res = await app.request(`/tags/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#222222' }),
    })
    expect(res.status).toBe(200)
    const updated = await res.json() as TagRow
    expect(updated.name).toBe('A')
    expect(updated.color).toBe('#222222')
  })

  it('PUT /tags/:id は存在しない id を 404 で返す', async () => {
    const res = await app.request('/tags/doesnotexist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#222222' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /tags/:id で削除でき、割り当ても連鎖削除される', async () => {
    await seedConnection(pools, 'conn000001')
    const created = await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', color: '#333333' }),
    })).json() as TagRow
    await pools.rw.query(
      `INSERT INTO storage_tag_assignments (tag_id, connection_id, bucket, target_kind, target_path)
       VALUES ($1, 'conn000001', 'bkt', 'bucket', '')`,
      [created.id],
    )

    const res = await app.request(`/tags/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const remaining = await pools.rw.query(
      'SELECT * FROM storage_tag_assignments WHERE tag_id = $1', [created.id],
    )
    expect(remaining.rows).toEqual([])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: FAIL (`Cannot find module './storage-tags.js'` または類似のインポートエラー)

- [ ] **Step 3: registry CRUD を実装する**

```typescript
// api/routes/storage-tags.ts
import type { Hono } from 'hono'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'

// README/favorites と同じ「オナーシステム」— 認証なし。
// 防御は LAN 境界 (requireSafeOrigin ミドルウェア) に委ねる。

export interface StorageTagsDeps {
  pools: Pools
}

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB')

const CreateTagBody = z.object({
  name: z.string().min(1).max(32),
  color: ColorSchema,
})

const UpdateTagBody = z.object({
  name: z.string().min(1).max(32).optional(),
  color: ColorSchema.optional(),
})

interface TagRow {
  id: string
  name: string
  color: string
}

export function mountStorageTagsRoutes(app: Hono, deps: StorageTagsDeps): void {
  app.get('/tags', async c => {
    const r = await deps.pools.ro.query<TagRow>(
      `SELECT id, name, color FROM storage_tags ORDER BY name`,
    )
    return c.json(r.rows)
  })

  app.post('/tags', async c => {
    const parsed = CreateTagBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, color } = parsed.data
    const id = nanoid(10)
    try {
      const r = await deps.pools.rw.query<TagRow>(
        `INSERT INTO storage_tags (id, name, color) VALUES ($1, $2, $3)
         RETURNING id, name, color`,
        [id, name, color],
      )
      return c.json(r.rows[0])
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_tags_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.put('/tags/:id', async c => {
    const id = c.req.param('id')
    const parsed = UpdateTagBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const u = parsed.data

    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if (u.name !== undefined)  { sets.push(`name = $${i++}`);  values.push(u.name) }
    if (u.color !== undefined) { sets.push(`color = $${i++}`); values.push(u.color) }
    if (sets.length === 0) {
      const r = await deps.pools.ro.query<TagRow>(
        `SELECT id, name, color FROM storage_tags WHERE id = $1`, [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(r.rows[0])
    }
    values.push(id)
    try {
      const r = await deps.pools.rw.query<TagRow>(
        `UPDATE storage_tags SET ${sets.join(', ')} WHERE id = $${i}
         RETURNING id, name, color`,
        values,
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(r.rows[0])
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_tags_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.delete('/tags/:id', async c => {
    const id = c.req.param('id')
    const r = await deps.pools.rw.query(`DELETE FROM storage_tags WHERE id = $1`, [id])
    if (r.rowCount === 0) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })
}
```

- [ ] **Step 4: internal.ts にマウントする**

`api/internal.ts` の import 群に追加:
```typescript
import { mountStorageTagsRoutes } from './routes/storage-tags.js'
```
`mountNotesRoutes(api, { pools })` の直後に追加:
```typescript
mountStorageTagsRoutes(api, { pools })
```

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: PASS (7 tests)

- [ ] **Step 6: lint とビルドを確認する**

Run: `cd api && npm run lint && npm run build`
Expected: エラーなく完了する

- [ ] **Step 7: Commit**

```bash
git add api/routes/storage-tags.ts api/routes/storage-tags.test.ts api/internal.ts
git commit -m "feat(api): タグレジストリ CRUD (GET/POST/PUT/DELETE /tags) を追加"
```

---

## Task 3: バックエンド — タグ割り当て (bucket/prefix/file)

**Files:**
- Modify: `api/routes/storage-tags.ts`
- Modify: `api/routes/storage-tags.test.ts`

**Interfaces:**
- Consumes: Task 2 の `mountStorageTagsRoutes` / `StorageTagsDeps`。`storage_tag_assignments` テーブル (Task 1)。
- Produces: 同じ `mountStorageTagsRoutes` に以下を追加:
  - `GET /storage/:connId/tags?bucket=&kind=bucket|prefix|file&paths=a&paths=b` → `{ [path]: string[] }` (path → tagId[])
  - `PUT /storage/:connId/tags` body `{ bucket, kind, path, tagId }` → `{ ok: true }`
  - `DELETE /storage/:connId/tags` body `{ bucket, kind, path, tagId }` → `{ ok: true }`

- [ ] **Step 1: 失敗するテストを追記する**

`api/routes/storage-tags.test.ts` の末尾に追記:
```typescript
describe('タグ割り当て', () => {
  async function createTag(name: string, color = '#123456'): Promise<TagRow> {
    return (await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    })).json()) as TagRow
  }

  beforeEach(async () => {
    await seedConnection(pools, 'conn000001')
  })

  it('GET はバッチで path→tagId[] を返す (割り当てなしは空配列)', async () => {
    const tag = await createTag('A')
    await app.request('/storage/conn000001/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: tag.id }),
    })

    const res = await app.request(
      '/storage/conn000001/tags?bucket=bkt&kind=prefix&paths=a/&paths=b/',
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'a/': [tag.id] })
  })

  it('PUT は冪等 (同じ組み合わせを二度投げてもエラーにならない)', async () => {
    const tag = await createTag('B')
    const body = JSON.stringify({ bucket: 'bkt', kind: 'file', path: 'x.txt', tagId: tag.id })
    const r1 = await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    const r2 = await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=file&paths=x.txt')
    expect(await res.json()).toEqual({ 'x.txt': [tag.id] })
  })

  it('kind=bucket のとき path は "" に正規化される', async () => {
    const tag = await createTag('C')
    await app.request('/storage/conn000001/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'bkt', kind: 'bucket', path: 'ignored', tagId: tag.id }),
    })
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=bucket&paths=')
    expect(await res.json()).toEqual({ '': [tag.id] })
  })

  it('DELETE で割り当てを解除できる', async () => {
    const tag = await createTag('D')
    const body = JSON.stringify({ bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: tag.id })
    await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    const del = await app.request('/storage/conn000001/tags', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(del.status).toBe(200)
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=prefix&paths=a/')
    expect(await res.json()).toEqual({})
  })

  it('paths が空なら GET は空オブジェクトを返す', async () => {
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=prefix')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: FAIL (新しい `describe('タグ割り当て')` 内のテストが 404 / undefined で落ちる)

- [ ] **Step 3: 割り当てエンドポイントを実装する**

`api/routes/storage-tags.ts` に追記 (`CreateTagBody` などの下に追加してから、`mountStorageTagsRoutes` 関数の中、`app.delete('/tags/:id', ...)` の後に追加):

```typescript
const TargetKindSchema = z.enum(['bucket', 'prefix', 'file'])

const AssignmentBody = z.object({
  bucket: z.string().min(1),
  kind: TargetKindSchema,
  path: z.string(),
  tagId: z.string().min(1),
})

// kind='bucket' は対象がバケット自体 1 つなので path を '' に固定する。
// 呼び出し側が何を渡しても同じキーに正規化することで、
// バケット自体のタグが複数の path に分裂しないようにする。
function normalizePath(kind: z.infer<typeof TargetKindSchema>, path: string): string {
  return kind === 'bucket' ? '' : path
}
```

続けて `mountStorageTagsRoutes` 内 (`app.delete('/tags/:id', ...)` の閉じ `})` の直後) に追加:

```typescript
  app.get('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const kindRaw = c.req.query('kind')
    const kindParsed = TargetKindSchema.safeParse(kindRaw)
    if (!kindParsed.success) return c.json({ error: 'kind must be bucket|prefix|file' }, 400)
    const kind = kindParsed.data
    const paths = c.req.queries('paths') ?? []
    if (paths.length === 0) return c.json({})

    const r = await deps.pools.ro.query<{ target_path: string; tag_id: string }>(
      `SELECT target_path, tag_id FROM storage_tag_assignments
         WHERE connection_id = $1 AND bucket = $2 AND target_kind = $3
           AND target_path = ANY($4::text[])`,
      [connId, bucket, kind, paths.map(p => normalizePath(kind, p))],
    )
    const out: Record<string, string[]> = {}
    for (const row of r.rows) {
      (out[row.target_path] ??= []).push(row.tag_id)
    }
    return c.json(out)
  })

  app.put('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const parsed = AssignmentBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { bucket, kind, path, tagId } = parsed.data
    await deps.pools.rw.query(
      `INSERT INTO storage_tag_assignments (tag_id, connection_id, bucket, target_kind, target_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id, bucket, target_kind, target_path, tag_id) DO NOTHING`,
      [tagId, connId, bucket, kind, normalizePath(kind, path)],
    )
    return c.json({ ok: true })
  })

  app.delete('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const parsed = AssignmentBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { bucket, kind, path, tagId } = parsed.data
    await deps.pools.rw.query(
      `DELETE FROM storage_tag_assignments
         WHERE tag_id = $1 AND connection_id = $2 AND bucket = $3
           AND target_kind = $4 AND target_path = $5`,
      [tagId, connId, bucket, kind, normalizePath(kind, path)],
    )
    return c.json({ ok: true })
  })
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: PASS (全 12 tests)

- [ ] **Step 5: lint を確認する**

Run: `cd api && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 6: Commit**

```bash
git add api/routes/storage-tags.ts api/routes/storage-tags.test.ts
git commit -m "feat(api): bucket/prefix/file へのタグ割り当てエンドポイントを追加"
```

---

## Task 4: バックエンド — 接続内タグ横断検索

**Files:**
- Modify: `api/routes/storage-tags.ts`
- Modify: `api/routes/storage-tags.test.ts`

**Interfaces:**
- Consumes: Task 3 の `AssignmentBody` / `TargetKindSchema` / `normalizePath`。
- Produces: `GET /storage/:connId/tags/search?tagId=a&tagId=b` → `[{ tagId, bucket, kind, path }]` (bucket, kind, path 順)。

- [ ] **Step 1: 失敗するテストを追記する**

`api/routes/storage-tags.test.ts` の末尾に追記:
```typescript
describe('タグ横断検索', () => {
  beforeEach(async () => {
    await seedConnection(pools, 'conn000001')
    await seedConnection(pools, 'conn000002')
  })

  it('選んだタグのいずれかを含む対象を、接続内の全バケットから返す', async () => {
    const tagA = await (await app.request('/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search-a', color: '#111111' }),
    })).json() as TagRow
    const tagB = await (await app.request('/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search-b', color: '#222222' }),
    })).json() as TagRow

    const assign = (bucket: string, kind: string, path: string, tagId: string) =>
      app.request('/storage/conn000001/tags', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, kind, path, tagId }),
      })
    await assign('bkt-1', 'bucket', '', tagA.id)
    await assign('bkt-2', 'prefix', 'dir/', tagB.id)
    await assign('bkt-2', 'file', 'dir/file.txt', tagA.id)
    // 別接続 (conn000002) の割り当ては横断検索の対象外
    await app.request('/storage/conn000002/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'other', kind: 'bucket', path: '', tagId: tagA.id }),
    })

    const res = await app.request(
      `/storage/conn000001/tags/search?tagId=${tagA.id}&tagId=${tagB.id}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { tagId: tagA.id, bucket: 'bkt-1', kind: 'bucket', path: '' },
      { tagId: tagB.id, bucket: 'bkt-2', kind: 'prefix', path: 'dir/' },
      { tagId: tagA.id, bucket: 'bkt-2', kind: 'file', path: 'dir/file.txt' },
    ])
  })

  it('tagId が無ければ空配列を返す', async () => {
    const res = await app.request('/storage/conn000001/tags/search')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: FAIL (`/tags/search` が 404 を返す)

- [ ] **Step 3: 検索エンドポイントを実装する**

`api/routes/storage-tags.ts` の `mountStorageTagsRoutes` 内、`app.delete('/storage/:connId/tags', ...)` の後に追加 (**このルートは `/storage/:connId/tags/:something` に食われないよう `/storage/:connId/tags` 系の最後に置く必要はない — Hono は静的セグメント `search` を `:connId` の子として明示的にマッチさせるので順序に依存しない**):

```typescript
  app.get('/storage/:connId/tags/search', async c => {
    const connId = c.req.param('connId')
    const tagIds = c.req.queries('tagId') ?? []
    if (tagIds.length === 0) return c.json([])

    const r = await deps.pools.ro.query<{
      tag_id: string; bucket: string; target_kind: string; target_path: string
    }>(
      `SELECT tag_id, bucket, target_kind, target_path
         FROM storage_tag_assignments
         WHERE connection_id = $1 AND tag_id = ANY($2::text[])
         ORDER BY bucket, target_path, target_kind`,
      [connId, tagIds],
    )
    return c.json(r.rows.map(row => ({
      tagId: row.tag_id,
      bucket: row.bucket,
      kind: row.target_kind,
      path: row.target_path,
    })))
  })
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd api && npm test -- storage-tags`
Expected: PASS (全 14 tests)

- [ ] **Step 5: api 全体のテストと lint を確認する**

Run: `cd api && npm test && npm run lint && npm run build`
Expected: 全て PASS / エラーなし (既存テストも壊れていないことを確認)

- [ ] **Step 6: Commit**

```bash
git add api/routes/storage-tags.ts api/routes/storage-tags.test.ts
git commit -m "feat(api): 接続内タグ横断検索エンドポイントを追加"
```

---

## Task 5: フロント — API クライアント (types.ts / client.ts)

**Files:**
- Modify: `front/lib/api/types.ts`
- Modify: `front/lib/api/client.ts`
- Create: `front/lib/api/tags-client.test.ts`

**Interfaces:**
- Consumes: Task 2〜4 で確定した API 形状。
- Produces:
  - 型: `Tag`, `TagList`, `TargetKind`, `TagAssignmentMap`, `TagSearchHit`, `TagSearchResult`, `TagCreateInput`, `TagUpdateInput`
  - `api.tags()`, `api.invalidateTags()`, `api.createTag(input)`, `api.updateTag(id, input)`, `api.deleteTag(id)`
  - `api.tagAssignments(connId, bucket, kind, paths)`, `api.invalidateTagAssignments(connId, bucket, kind)`
  - `api.assignTag(connId, bucket, kind, path, tagId)`, `api.unassignTag(connId, bucket, kind, path, tagId)`
  - `api.tagSearch(connId, tagIds)`
  - 後続タスク (6〜12) はこれらのシグネチャのみに依存する。

- [ ] **Step 1: types.ts にスキーマを追加する**

`front/lib/api/types.ts` の末尾に追記:
```typescript
// タグ (事前定義、全接続共通レジストリ)
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
})
export type Tag = z.infer<typeof Tag>
export const TagList = z.array(Tag)

export interface TagCreateInput { name: string; color: string }
export interface TagUpdateInput { name?: string; color?: string }

// bucket 自体 / ディレクトリ (prefix) / ファイル (key) — タグ割り当ての対象種別
export const TargetKind = z.enum(['bucket', 'prefix', 'file'])
export type TargetKind = z.infer<typeof TargetKind>

// バッチ取得: path → 割り当て済み tagId[]
export const TagAssignmentMap = z.record(z.string(), z.array(z.string()))

// 接続内横断検索のヒット 1 件
export const TagSearchHit = z.object({
  tagId: z.string(),
  bucket: z.string(),
  kind: TargetKind,
  path: z.string(),
})
export const TagSearchResult = z.array(TagSearchHit)
```

- [ ] **Step 2: 失敗するテストを書く (client.ts)**

```typescript
// front/lib/api/tags-client.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

describe('tags client', () => {
  it('tags() はレジストリ一覧を parse する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      { id: 't1', name: '重要', color: '#ff0000' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const list = await api.tags()
    expect(list).toEqual([{ id: 't1', name: '重要', color: '#ff0000' }])
  })

  it('createTag は POST /tags を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 't1', name: 'A', color: '#111111' }), { status: 200 }))
    await api.createTag({ name: 'A', color: '#111111' })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'A', color: '#111111' })
  })

  it('updateTag は PUT /tags/:id を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 't1', name: 'A', color: '#222222' }), { status: 200 }))
    await api.updateTag('t 1', { color: '#222222' })
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags/t%201')
    expect((init as RequestInit).method).toBe('PUT')
  })

  it('deleteTag は DELETE /tags/:id を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.deleteTag('t1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/tags/t1')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('tagAssignments は paths を繰り返しクエリで渡す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ 'a/': ['t1'] }), { status: 200 }))
    const out = await api.tagAssignments('c1', 'bkt', 'prefix', ['a/', 'b/'])
    expect(out).toEqual({ 'a/': ['t1'] })
    const [url] = spy.mock.calls[0]
    const u = new URL(String(url), 'http://x')
    expect(u.pathname).toBe('/api/internal/storage/c1/tags')
    expect(u.searchParams.getAll('paths')).toEqual(['a/', 'b/'])
    expect(u.searchParams.get('kind')).toBe('prefix')
  })

  it('tagAssignments は paths が空なら fetch せず {} を返す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const out = await api.tagAssignments('c1', 'bkt', 'file', [])
    expect(out).toEqual({})
    expect(spy).not.toHaveBeenCalled()
  })

  it('assignTag は PUT body で bucket/kind/path/tagId を送る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.assignTag('c1', 'bkt', 'file', 'a/b.txt', 't1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c1/tags')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      bucket: 'bkt', kind: 'file', path: 'a/b.txt', tagId: 't1',
    })
  })

  it('unassignTag は DELETE body で bucket/kind/path/tagId を送る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.unassignTag('c1', 'bkt', 'prefix', 'a/', 't1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c1/tags')
    expect((init as RequestInit).method).toBe('DELETE')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: 't1',
    })
  })

  it('tagSearch は tagId を繰り返しクエリで渡す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ tagId: 't1', bucket: 'b', kind: 'bucket', path: '' }]), { status: 200 }))
    const out = await api.tagSearch('c1', ['t1', 't2'])
    expect(out).toEqual([{ tagId: 't1', bucket: 'b', kind: 'bucket', path: '' }])
    const [url] = spy.mock.calls[0]
    const u = new URL(String(url), 'http://x')
    expect(u.pathname).toBe('/api/internal/storage/c1/tags/search')
    expect(u.searchParams.getAll('tagId')).toEqual(['t1', 't2'])
  })
})
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `cd front && npm test -- tags-client`
Expected: FAIL (`api.tags is not a function` 等)

- [ ] **Step 4: client.ts に実装を追加する**

`front/lib/api/client.ts` の import に追記:
```typescript
import {
  Connection,
  ConnectionList,
  FavoriteBuckets,
  ListBuckets,
  MediaAnalyze,
  Note,
  NoteHistoryList,
  NoteHistoryVersion,
  PutNoteOk,
  PutReadmeOk,
  Readme,
  ReadmeHistoryList,
  ReadmeHistoryVersion,
  ReadmeSearchResult,
  StorageList,
  Tag,
  TagAssignmentMap,
  TagList,
  TagSearchResult,
  TarPreview,
} from './types'
import type { ConnectionCreateInput, ConnectionUpdateInput, TagCreateInput, TagUpdateInput, TargetKind } from './types'
```

`favoritesCache` の下に追記:
```typescript
const tagsCache            = new TTLCache<z.infer<typeof TagList>>(CACHE_TTL_MS)
const tagAssignmentsCache  = new TTLCache<z.infer<typeof TagAssignmentMap>>(CACHE_TTL_MS)
```

`export const api = { ... }` の中、`removeFavorite` の直後 (`lastFetched` の前) に追記:
```typescript
  tags: () => tagsCache.get('tags', () => getJson(`${API_BASE}/tags`, TagList)),

  invalidateTags: (): void => { tagsCache.invalidate('tags') },

  createTag: async (input: TagCreateInput): Promise<z.infer<typeof Tag>> => {
    const t = await mutateJson(`${API_BASE}/tags`, { method: 'POST', body: input }, Tag)
    tagsCache.invalidate('tags')
    return t
  },

  updateTag: async (id: string, input: TagUpdateInput): Promise<z.infer<typeof Tag>> => {
    const t = await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'PUT', body: input }, Tag)
    tagsCache.invalidate('tags')
    return t
  },

  deleteTag: async (id: string): Promise<void> => {
    await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }, null)
    tagsCache.invalidate('tags')
  },

  // 一覧をまとめて hydrate するバッチ取得。paths が空なら fetch しない
  // (呼び出し側が dirs/files 0 件のときに空 URL を叩かないための短絡)。
  tagAssignments: (
    connId: string, bucket: string, kind: TargetKind, paths: string[],
  ): Promise<z.infer<typeof TagAssignmentMap>> => {
    if (paths.length === 0) return Promise.resolve({})
    const cacheKey = k('tagAssignments', connId, bucket, kind, ...paths)
    return tagAssignmentsCache.get(cacheKey, () => {
      const search = new URLSearchParams({ bucket, kind })
      for (const p of paths) search.append('paths', p)
      return getJson(
        `${API_BASE}/storage/${encodeURIComponent(connId)}/tags?${search.toString()}`,
        TagAssignmentMap,
      )
    })
  },

  invalidateTagAssignments: (connId: string, bucket: string, kind: TargetKind): void => {
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  assignTag: async (
    connId: string, bucket: string, kind: TargetKind, path: string, tagId: string,
  ): Promise<void> => {
    await mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags`,
      { method: 'PUT', body: { bucket, kind, path, tagId } },
      null,
    )
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  unassignTag: async (
    connId: string, bucket: string, kind: TargetKind, path: string, tagId: string,
  ): Promise<void> => {
    await mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags`,
      { method: 'DELETE', body: { bucket, kind, path, tagId } },
      null,
    )
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  // 同一接続内の全バケットを横断して、選んだタグのいずれかが付いた対象を返す。
  tagSearch: (connId: string, tagIds: string[]): Promise<z.infer<typeof TagSearchResult>> => {
    const search = new URLSearchParams()
    for (const id of tagIds) search.append('tagId', id)
    return getJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags/search?${search.toString()}`,
      TagSearchResult,
    )
  },
```

`mutateJson` の `init.method` 型union は `'POST' | 'PUT' | 'DELETE'` のままで良い (`PUT`/`DELETE` は既に含まれる — 変更不要)。

- [ ] **Step 5: テストを実行して通ることを確認する**

Run: `cd front && npm test -- tags-client`
Expected: PASS (10 tests)

- [ ] **Step 6: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 7: Commit**

```bash
git add front/lib/api/types.ts front/lib/api/client.ts front/lib/api/tags-client.test.ts
git commit -m "feat(front): タグ API クライアント (types/client) を追加"
```

---

## Task 6: フロント — `TagBadge` コンポーネント

**Files:**
- Create: `front/components/TagBadge.tsx`
- Create: `front/components/TagBadge.test.tsx`

**Interfaces:**
- Consumes: `Tag` 型 (`front/lib/api/types.ts`、Task 5)。
- Produces: `TagBadge({ tag }: { tag: Pick<Tag, 'name' | 'color'> }): JSX.Element` — 後続タスクで一覧の行・フィルタチップ・検索パネルから再利用する。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/components/TagBadge.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TagBadge } from './TagBadge'

describe('TagBadge', () => {
  it('タグ名を表示する', () => {
    render(<TagBadge tag={{ name: '重要', color: '#ff0000' }} />)
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('背景色に tag.color を使う', () => {
    render(<TagBadge tag={{ name: 'A', color: '#ff0000' }} />)
    const el = screen.getByText('A')
    expect(el.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('暗い背景では白文字、明るい背景では黒文字になる', () => {
    render(
      <>
        <TagBadge tag={{ name: 'dark', color: '#000000' }} />
        <TagBadge tag={{ name: 'light', color: '#ffffff' }} />
      </>,
    )
    expect(screen.getByText('dark').style.color).toBe('rgb(255, 255, 255)')
    expect(screen.getByText('light').style.color).toBe('rgb(0, 0, 0)')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- TagBadge`
Expected: FAIL (`Cannot find module './TagBadge'`)

- [ ] **Step 3: 実装する**

```tsx
// front/components/TagBadge.tsx
// 背景の相対輝度 (WCAG 近似) から文字色を白/黒に自動判定する。
// #RRGGBB 形式のみを想定 (storage-tags API がこの形式のみ許可するため)。
function contrastTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

interface Props {
  tag: { name: string; color: string }
}

export function TagBadge({ tag }: Props) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-none"
      style={{
        backgroundColor: tag.color,
        color: contrastTextColor(tag.color),
        letterSpacing: '0.01em',
      }}
    >
      {tag.name}
    </span>
  )
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- TagBadge`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add front/components/TagBadge.tsx front/components/TagBadge.test.tsx
git commit -m "feat(front): TagBadge コンポーネントを追加"
```

---

## Task 7: フロント — `TagPicker` コンポーネント (タグ編集モーダル)

**Files:**
- Create: `front/components/TagPicker.tsx`
- Create: `front/components/TagPicker.test.tsx`

**Interfaces:**
- Consumes: `Tag`, `TargetKind` 型・`api.assignTag`/`api.unassignTag` (Task 5)。
- Produces:
```typescript
interface TagPickerProps {
  connId: string
  bucket: string
  kind: TargetKind
  path: string
  label: string                    // モーダルタイトルに出す対象名 (例: バケット名 / ディレクトリ末尾 / ファイル名)
  allTags: Tag[]                   // レジストリ全件 (呼び出し元が事前に取得して渡す)
  assignedTagIds: string[]
  onChange: (nextAssignedTagIds: string[]) => void  // 成功したトグルのたびに呼ぶ
  onClose: () => void
}
export function TagPicker(props: TagPickerProps): JSX.Element
```
後続タスク (8, 10) がこのコンポーネントを行の「タグを編集」アクションから開く。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/components/TagPicker.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { TagPicker } from './TagPicker'

afterEach(() => vi.restoreAllMocks())

const TAGS = [
  { id: 't1', name: '重要', color: '#ff0000' },
  { id: 't2', name: '未整理', color: '#00ff00' },
]

describe('TagPicker', () => {
  it('割り当て済みタグがチェック済みで表示される', () => {
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={TAGS} assignedTagIds={['t1']}
        onChange={() => {}} onClose={() => {}}
      />,
    )
    expect(screen.getByRole('checkbox', { name: '重要' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '未整理' })).not.toBeChecked()
  })

  it('チェックすると assignTag を呼び、onChange で反映する', async () => {
    const assignSpy = vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    const onChange = vi.fn()
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={TAGS} assignedTagIds={[]}
        onChange={onChange} onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(assignSpy).toHaveBeenCalledWith('c1', 'bkt', 'file', 'a.txt', 't1')
    expect(onChange).toHaveBeenCalledWith(['t1'])
  })

  it('チェックを外すと unassignTag を呼び、onChange で反映する', async () => {
    const unassignSpy = vi.spyOn(api, 'unassignTag').mockResolvedValue(undefined)
    const onChange = vi.fn()
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={TAGS} assignedTagIds={['t1']}
        onChange={onChange} onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(unassignSpy).toHaveBeenCalledWith('c1', 'bkt', 'file', 'a.txt', 't1')
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('API が失敗したらチェック状態を戻しエラーを表示する', async () => {
    vi.spyOn(api, 'assignTag').mockRejectedValue(new Error('boom'))
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={TAGS} assignedTagIds={[]}
        onChange={() => {}} onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '重要' })).not.toBeChecked()
  })

  it('タグが 0 件なら案内メッセージを出す', () => {
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={[]} assignedTagIds={[]}
        onChange={() => {}} onClose={() => {}}
      />,
    )
    expect(screen.getByText(/タグがまだありません/)).toBeInTheDocument()
  })

  it('閉じるボタンで onClose が呼ばれる', () => {
    const onClose = vi.fn()
    render(
      <TagPicker
        connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
        allTags={TAGS} assignedTagIds={[]}
        onChange={() => {}} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- TagPicker`
Expected: FAIL (`Cannot find module './TagPicker'`)

- [ ] **Step 3: 実装する**

```tsx
// front/components/TagPicker.tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TargetKind } from '../lib/api/types'
import { TagBadge } from './TagBadge'

interface Props {
  connId: string
  bucket: string
  kind: TargetKind
  path: string
  label: string
  allTags: Tag[]
  assignedTagIds: string[]
  onChange: (nextAssignedTagIds: string[]) => void
  onClose: () => void
}

// 対象 1 件 (bucket/prefix/file) へのタグ割り当てを編集するモーダル。
// 新規タグの作成はここではできない (Settings の TagsSettings のみ) —
// 一覧作業中に語彙が無秩序に増えるのを防ぐため。
export function TagPicker({
  connId, bucket, kind, path, label, allTags, assignedTagIds, onChange, onClose,
}: Props) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedTagIds))
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (tag: Tag) => {
    const wasAssigned = assigned.has(tag.id)
    setError(null)
    setBusyId(tag.id)
    const next = new Set(assigned)
    if (wasAssigned) next.delete(tag.id); else next.add(tag.id)
    setAssigned(next)
    try {
      if (wasAssigned) await api.unassignTag(connId, bucket, kind, path, tag.id)
      else await api.assignTag(connId, bucket, kind, path, tag.id)
      onChange([...next])
    } catch (e) {
      // 失敗時はチェック状態を戻す (楽観更新のロールバック)。
      setAssigned(assigned)
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-picker-title"
      >
        <p className="kicker">タグ</p>
        <h3 id="tag-picker-title">{label}</h3>

        {allTags.length === 0 ? (
          <p className="text-[13px] text-ink-7">
            タグがまだありません。<Link to="/connections">Settings</Link> で作成してください。
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {allTags.map(tag => (
              <li key={tag.id} className="flex items-center gap-3 py-2">
                <label className="flex flex-1 items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    aria-label={tag.name}
                    checked={assigned.has(tag.id)}
                    disabled={busyId === tag.id}
                    onChange={() => toggle(tag)}
                  />
                  <TagBadge tag={tag} />
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- TagPicker`
Expected: PASS (6 tests)

- [ ] **Step 5: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 6: Commit**

```bash
git add front/components/TagPicker.tsx front/components/TagPicker.test.tsx
git commit -m "feat(front): TagPicker (タグ編集モーダル) を追加"
```

---

## Task 8: フロント — `EntryTable` へのバッジ・編集導線の組み込み

**Files:**
- Modify: `front/components/storage/EntryTable.tsx`
- Create: `front/components/storage/EntryTable.tags.test.tsx`

**Interfaces:**
- Consumes: `TagBadge` (Task 6)、`TagPicker` (Task 7)、`Tag` 型 (Task 5)。
- Produces: `EntryTable` の Props に以下を追加 (既存 Props はそのまま維持、後方互換のため両方 optional):
```typescript
interface Props {
  dirs: string[]
  files: FileEntry[]
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags?: Tag[]                          // 既定 []
  tagsByPath?: Record<string, string[]>    // 既定 {} — key はディレクトリなら full path (= d そのもの)、ファイルなら f.key
  onTagsChange?: (path: string, tagIds: string[]) => void
}
```
Task 9 (`StorageBrowser`) はこの Props で `tagsByPath` / `allTags` / `onTagsChange` を渡す。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/components/storage/EntryTable.tags.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api/client'
import { EntryTable } from './EntryTable'

const ALL_TAGS = [{ id: 't1', name: '重要', color: '#ff0000' }]

describe('EntryTable タグ', () => {
  it('割り当て済みタグがファイル行にバッジ表示される', () => {
    render(
      <MemoryRouter>
        <EntryTable
          dirs={[]}
          files={[{ key: 'notes.txt', size: 10, lastModified: null }]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{ 'notes.txt': ['t1'] }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('割り当て済みタグがディレクトリ行にバッジ表示される', () => {
    render(
      <MemoryRouter>
        <EntryTable
          dirs={['sub/']}
          files={[]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{ 'sub/': ['t1'] }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('⋯ メニューの「タグを編集」で TagPicker が開き、トグルすると onTagsChange が呼ばれる', async () => {
    vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    const onTagsChange = vi.fn()
    render(
      <MemoryRouter>
        <EntryTable
          dirs={[]}
          files={[{ key: 'notes.txt', size: 10, lastModified: null }]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{}}
          onTagsChange={onTagsChange}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('タグを編集'))
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(onTagsChange).toHaveBeenCalledWith('notes.txt', ['t1'])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- EntryTable.tags`
Expected: FAIL (「タグを編集」が見つからない / バッジが表示されない)

- [ ] **Step 3: EntryTable.tsx を修正する**

`front/components/storage/EntryTable.tsx` の import 群に追記:
```typescript
import type { Tag } from '../../lib/api/types'
import { TagBadge } from '../TagBadge'
import { TagPicker } from '../TagPicker'
```

`Props` インターフェースを拡張:
```typescript
interface Props {
  dirs: string[]
  files: FileEntry[]
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags?: Tag[]
  tagsByPath?: Record<string, string[]>
  onTagsChange?: (path: string, tagIds: string[]) => void
}
```

`DirRow` を書き換え (元の `d, prefix, connId, bucket` props に `allTags, tagIds, onTagsChange` を追加):
```typescript
const DirRow = memo(function DirRow({
  d, prefix, connId, bucket, allTags, tagIds, onTagsChange,
}: {
  d: string; prefix: string; connId: string; bucket: string
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = `${window.location.origin}${dirHref}`
  const tags = allTags.filter(t => tagIds.includes(t.id))
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
    { kind: 'action', label: 'タグを編集', onSelect: () => setPickerOpen(true) },
  ], [dirWebUrl, dirS3Url])
  return (
    <>
      <tr className={dirRowClass} style={{ borderBottom: '1px solid var(--rule)' }}>
        <td className={`${tdNameClass} p-0`}>
          <Link
            to={dirHref}
            className={
              'flex items-baseline gap-2 px-2 py-2.5 ' +
              'font-semibold text-ink-12 no-underline'
            }
          >
            <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
            <span className="truncate">{tail}</span>
            {tags.map(t => <TagBadge key={t.id} tag={t} />)}
          </Link>
        </td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>-</td>
        <td className={tdNumClass}>
          <CopyMenu items={items} />
        </td>
      </tr>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="prefix" path={d} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(d, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
})
```

`FileRow` を同様に書き換え (`f, prefix, connId, bucket, onSelectFile` に `allTags, tagIds, onTagsChange` を追加):
```typescript
const FileRow = memo(function FileRow({
  f, prefix, connId, bucket, onSelectFile, allTags, tagIds, onTagsChange,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
}) {
  const deck = usePlayerDeck()
  const pinned = usePinnedPreviews()
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
  const select = useCallback(() => onSelectFile?.(f.key), [onSelectFile, f.key])
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  const webUrl = `${window.location.origin}`
    + `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const isAudio = classify(f.key) === 'audio'
  const tags = allTags.filter(t => tagIds.includes(t.id))
  const items = useMemo<MenuItem[]>(() => [
    ...(isAudio ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connId, bucket, key: f.key,
      }),
    }] : []),
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connId, bucket, key: f.key }),
    },
    { kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) },
    { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [isAudio, deck, pinned, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
  return (
    <>
      <tr
        className={fileRowClass}
        style={{ borderBottom: '1px solid var(--rule)' }}
        role="button"
        tabIndex={0}
        onClick={select}
        onKeyDown={onKeyDown}
      >
        <td className={tdNameClass}>
          <span className="flex items-baseline gap-2">
            <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>
            <span
              className="truncate text-ink-11"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12.5px',
                letterSpacing: '0.005em',
              }}
            >
              {tail}
            </span>
            {tags.map(t => <TagBadge key={t.id} tag={t} />)}
          </span>
        </td>
        <td className={tdNumClass}>{fmtSize(f.size)}</td>
        <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
        <td className={tdNumClass}>
          <CopyMenu items={items} />
        </td>
      </tr>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="file" path={f.key} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(f.key, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  )
})
```

`useState` を react import に追加 (ファイル先頭):
```typescript
import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
```
(既に `useState` は import 済み — 変更不要。念のため確認のみ)

`DirCard` / `FileCard` にも同じパターンでバッジ + 「タグを編集」導線を追加する (table 版と対称に保つ):
```typescript
const DirCard = memo(function DirCard({
  d, prefix, connId, bucket, allTags, tagIds, onTagsChange,
}: {
  d: string; prefix: string; connId: string; bucket: string
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
  const dirHref = `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(d)}`
  const dirS3Url = `s3://${bucket}/${d}`
  const dirWebUrl = `${window.location.origin}${dirHref}`
  const tags = allTags.filter(t => tagIds.includes(t.id))
  const items = useMemo<MenuItem[]>(() => [
    { kind: 'copy', label: 'Web URL をコピー', value: dirWebUrl },
    { kind: 'copy', label: 'S3 URL をコピー', value: dirS3Url },
    { kind: 'action', label: 'タグを編集', onSelect: () => setPickerOpen(true) },
  ], [dirWebUrl, dirS3Url])
  return (
    <li
      className="transition-colors hover:bg-ink-0 focus-within:bg-ink-1"
      style={{ borderBottom: '1px solid var(--rule)' }}
    >
      <div className="flex items-baseline gap-2 px-2 py-3">
        <Link
          to={dirHref}
          className="flex-1 min-w-0 flex items-baseline gap-2 font-semibold text-ink-12 no-underline"
        >
          <span aria-hidden className="text-ink-5 select-none text-[10px]">▸</span>
          <span className="break-all">{tail}</span>
          {tags.map(t => <TagBadge key={t.id} tag={t} />)}
        </Link>
        <CopyMenu items={items} />
      </div>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="prefix" path={d} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(d, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </li>
  )
})
```

```typescript
const FileCard = memo(function FileCard({
  f, prefix, connId, bucket, onSelectFile, allTags, tagIds, onTagsChange,
}: {
  f: FileEntry
  prefix: string
  connId: string
  bucket: string
  onSelectFile?: (key: string) => void
  allTags: Tag[]; tagIds: string[]; onTagsChange?: (path: string, tagIds: string[]) => void
}) {
  const deck = usePlayerDeck()
  const pinned = usePinnedPreviews()
  const [pickerOpen, setPickerOpen] = useState(false)
  const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
  const select = useCallback(() => onSelectFile?.(f.key), [onSelectFile, f.key])
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }, [select])
  const webUrl = `${window.location.origin}`
    + `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket)}/${encPath(prefix)}`
    + `?preview=${encodeURIComponent(f.key)}`
  const s3Url = `s3://${bucket}/${f.key}`
  const downloadUrl = api.downloadUrl(connId, bucket, f.key)
  const filename = f.key.split('/').pop() ?? 'file'
  const isAudio = classify(f.key) === 'audio'
  const tags = allTags.filter(t => tagIds.includes(t.id))
  const items = useMemo<MenuItem[]>(() => [
    ...(isAudio ? [{
      kind: 'action' as const,
      label: 'デッキに追加',
      onSelect: () => deck.addTrack({
        label: filename, connId, bucket, key: f.key,
      }),
    }] : []),
    {
      kind: 'action' as const,
      label: 'ピン留め',
      onSelect: () => pinned.addPin({ connId, bucket, key: f.key }),
    },
    { kind: 'action' as const, label: 'タグを編集', onSelect: () => setPickerOpen(true) },
    { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
    { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
    { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
  ], [isAudio, deck, pinned, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
  return (
    <li
      className="cursor-pointer transition-colors hover:bg-ink-0 focus-within:bg-ink-1"
      style={{ borderBottom: '1px solid var(--rule)' }}
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start gap-2 px-2 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span aria-hidden className="text-ink-3 select-none text-[10px]">·</span>
            <span
              className="break-all text-ink-11"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12.5px',
                letterSpacing: '0.005em',
              }}
            >
              {tail}
            </span>
            {tags.map(t => <TagBadge key={t.id} tag={t} />)}
          </div>
          <div
            className="mt-1 ml-3 text-[11px] text-ink-7 tabular-nums"
            style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}
          >
            <span>{fmtSize(f.size)}</span>
            {f.lastModified && (
              <>
                {' '}<span className="text-ink-3">·</span>{' '}
                <span>{f.lastModified.slice(0, 10)}</span>
              </>
            )}
          </div>
        </div>
        <CopyMenu items={items} />
      </div>
      {pickerOpen && (
        <TagPicker
          connId={connId} bucket={bucket} kind="file" path={f.key} label={tail}
          allTags={allTags} assignedTagIds={tagIds}
          onChange={next => onTagsChange?.(f.key, next)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </li>
  )
})
```

最後に `EntryTable` 本体を書き換え、`allTags`/`tagsByPath`/`onTagsChange` を各行へ配る:
```typescript
export function EntryTable({
  dirs, files, prefix, connId, bucket, onSelectFile,
  allTags = [], tagsByPath = {}, onTagsChange,
}: Props) {
  const isCompact = useIsCompact()
  if (isCompact) {
    return (
      <ul
        className="m-0 list-none p-0"
        style={{ borderTop: '1px solid var(--color-rule-strong)' }}
      >
        {dirs.map(d => (
          <DirCard
            key={d} d={d} prefix={prefix} connId={connId} bucket={bucket}
            allTags={allTags} tagIds={tagsByPath[d] ?? []} onTagsChange={onTagsChange}
          />
        ))}
        {files.map(f => (
          <FileCard
            key={f.key}
            f={f}
            prefix={prefix}
            connId={connId}
            bucket={bucket}
            onSelectFile={onSelectFile}
            allTags={allTags} tagIds={tagsByPath[f.key] ?? []} onTagsChange={onTagsChange}
          />
        ))}
      </ul>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-rule-strong)' }}>
            <th className={headThClass}>Name</th>
            <th className={`${headThClass} text-right`}>Size</th>
            <th className={`${headThClass} text-right`}>Modified</th>
            <th className={headThClass}></th>
          </tr>
        </thead>
        <tbody>
          {dirs.map(d => (
            <DirRow
              key={d} d={d} prefix={prefix} connId={connId} bucket={bucket}
              allTags={allTags} tagIds={tagsByPath[d] ?? []} onTagsChange={onTagsChange}
            />
          ))}
          {files.map(f => (
            <FileRow
              key={f.key}
              f={f}
              prefix={prefix}
              connId={connId}
              bucket={bucket}
              onSelectFile={onSelectFile}
              allTags={allTags} tagIds={tagsByPath[f.key] ?? []} onTagsChange={onTagsChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- EntryTable`
Expected: PASS (`EntryTable.tags.test.tsx` の 3 件、および既存 `EntryTable.pin.test.tsx` / `EntryTable.deck.test.tsx` も引き続き PASS)

- [ ] **Step 5: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 6: Commit**

```bash
git add front/components/storage/EntryTable.tsx front/components/storage/EntryTable.tags.test.tsx
git commit -m "feat(front): EntryTable にタグバッジ表示・編集導線を追加"
```

---

## Task 9: フロント — `StorageBrowser` でのタグ取得・絞り込み (`TagFilterBar`)

**Files:**
- Create: `front/components/storage/TagFilterBar.tsx`
- Create: `front/components/storage/TagFilterBar.test.tsx`
- Modify: `front/components/StorageBrowser.tsx`
- Create: `front/components/StorageBrowser.tags.test.tsx`

**Interfaces:**
- Consumes: `api.tags()` / `api.tagAssignments()` (Task 5)、`TagBadge` (Task 6)、`EntryTable` の拡張 Props (Task 8)。
- Produces: `TagFilterBar({ tags, selected, onToggle, onClear }: TagFilterBarProps): JSX.Element` — Task 10 (StorageIndex) でも再利用する。

- [ ] **Step 1: TagFilterBar の失敗するテストを書く**

```tsx
// front/components/storage/TagFilterBar.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TagFilterBar } from './TagFilterBar'

const TAGS = [
  { id: 't1', name: '重要', color: '#ff0000' },
  { id: 't2', name: '未整理', color: '#00ff00' },
]

describe('TagFilterBar', () => {
  it('tags が空なら何も描画しない', () => {
    const { container } = render(
      <TagFilterBar tags={[]} selected={new Set()} onToggle={() => {}} onClear={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('候補タグをチップで表示し、クリックで onToggle を呼ぶ', () => {
    const onToggle = vi.fn()
    render(
      <TagFilterBar tags={TAGS} selected={new Set()} onToggle={onToggle} onClear={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '重要' }))
    expect(onToggle).toHaveBeenCalledWith('t1')
  })

  it('選択中は「クリア」ボタンが出る', () => {
    const onClear = vi.fn()
    render(
      <TagFilterBar tags={TAGS} selected={new Set(['t1'])} onToggle={() => {}} onClear={onClear} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(onClear).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- TagFilterBar`
Expected: FAIL (`Cannot find module './TagFilterBar'`)

- [ ] **Step 3: TagFilterBar を実装する**

```tsx
// front/components/storage/TagFilterBar.tsx
import type { Tag } from '../../lib/api/types'
import { TagBadge } from '../TagBadge'

interface Props {
  tags: Tag[]              // 今表示中の行に実際に出現する候補タグのみ
  selected: Set<string>
  onToggle: (tagId: string) => void
  onClear: () => void
}

// 一覧上部の絞り込みチップ。選んだタグのいずれかを含む行だけに絞る (OR)。
// クライアント側フィルタ — 取得済みの一覧データに対して行う。
export function TagFilterBar({ tags, selected, onToggle, onClear }: Props) {
  if (tags.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
        タグで絞り込み
      </span>
      {tags.map(tag => (
        <button
          key={tag.id}
          type="button"
          onClick={() => onToggle(tag.id)}
          className="border-0 bg-transparent p-0 cursor-pointer"
          style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.4 }}
          aria-pressed={selected.has(tag.id)}
        >
          <TagBadge tag={tag} />
        </button>
      ))}
      {selected.size > 0 && (
        <button type="button" className="ghost" onClick={onClear}>クリア</button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: TagFilterBar のテストを実行して通ることを確認する**

Run: `cd front && npm test -- TagFilterBar`
Expected: PASS (3 tests)

- [ ] **Step 5: StorageBrowser の失敗するテストを書く**

```tsx
// front/components/StorageBrowser.tags.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { StorageBrowser } from './StorageBrowser'

afterEach(() => vi.restoreAllMocks())

describe('StorageBrowser タグ', () => {
  it('一覧取得後にタグをバッチ取得してバッジ表示する', async () => {
    vi.spyOn(api, 'list').mockResolvedValue({
      directories: [], files: [{ key: 'a.txt', size: 1, lastModified: null }],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockImplementation(async (_c, _b, kind) =>
      kind === 'file' ? { 'a.txt': ['t1'] } : {})
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="bkt" prefix="" />
      </MemoryRouter>,
    )
    expect(await screen.findByText('重要')).toBeInTheDocument()
  })

  it('タグチップを選ぶと一致しない行が隠れる', async () => {
    vi.spyOn(api, 'list').mockResolvedValue({
      directories: [],
      files: [
        { key: 'a.txt', size: 1, lastModified: null },
        { key: 'b.txt', size: 1, lastModified: null },
      ],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockImplementation(async (_c, _b, kind) =>
      kind === 'file' ? { 'a.txt': ['t1'] } : {})
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="bkt" prefix="" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    expect(screen.getByText('b.txt')).toBeInTheDocument()

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: '重要' }))

    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('b.txt')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 6: テストが失敗することを確認する**

Run: `cd front && npm test -- StorageBrowser.tags`
Expected: FAIL (バッジが表示されない / フィルタが効かない)

- [ ] **Step 7: StorageBrowser.tsx を修正する**

`front/components/StorageBrowser.tsx` の import に追記:
```typescript
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import type { Tag } from '../lib/api/types'
import { EntryTable } from './storage/EntryTable'
import { Pager } from './storage/Pager'
import { SearchBar } from './storage/SearchBar'
import { TagFilterBar } from './storage/TagFilterBar'
```
(既存の `useCallback, useEffect, useReducer, useRef` に `useMemo, useState` を追加)

`StorageBrowser` 関数の本体、`const dirs = page?.directories ?? []` の前後を以下のように拡張する。まず既存の `page`/`dirs`/`files` 算出のすぐ下に、タグ関連の state と effect を追加:

```typescript
  const dirs = page?.directories ?? []
  const files = page?.files ?? []

  // タグ: レジストリ全件 + 表示中の dirs/files 分のバッチ割り当てを取得する。
  // dirs/files が変わるたび (ページ送り・検索・prefix 遷移) に再取得する。
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [dirTags, setDirTags] = useState<Record<string, string[]>>({})
  const [fileTags, setFileTags] = useState<Record<string, string[]>>({})
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())

  useEffect(() => { api.tags().then(setAllTags).catch(() => {}) }, [connId])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.tagAssignments(connId, bucket, 'prefix', dirs),
      api.tagAssignments(connId, bucket, 'file', files.map(f => f.key)),
    ]).then(([d, f]) => {
      if (cancelled) return
      setDirTags(d)
      setFileTags(f)
    }).catch(() => {})
    return () => { cancelled = true }
    // dirs/files は毎レンダ新しい配列参照になるため、実際の中身 (キー結合) で比較する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, dirs.join(' '), files.map(f => f.key).join(' ')])

  const handleTagsChange = useCallback((path: string, tagIds: string[]) => {
    setDirTags(prev => (path in prev || dirs.includes(path)) ? { ...prev, [path]: tagIds } : prev)
    setFileTags(prev => (path in prev || files.some(f => f.key === path)) ? { ...prev, [path]: tagIds } : prev)
  }, [dirs, files])

  const tagsByPath = useMemo(() => ({ ...dirTags, ...fileTags }), [dirTags, fileTags])

  // 絞り込みチップの候補: 今表示中の行に実際に出現するタグのみ。
  const visibleTagIds = useMemo(() => new Set(Object.values(tagsByPath).flat()), [tagsByPath])
  const filterCandidates = useMemo(
    () => allTags.filter(t => visibleTagIds.has(t.id)),
    [allTags, visibleTagIds],
  )

  const matchesSelectedTags = useCallback((path: string): boolean => {
    if (selectedTagIds.size === 0) return true
    const ids = tagsByPath[path] ?? []
    return ids.some(id => selectedTagIds.has(id))
  }, [selectedTagIds, tagsByPath])

  const visibleDirs = useMemo(() => dirs.filter(matchesSelectedTags), [dirs, matchesSelectedTags])
  const visibleFiles = useMemo(() => files.filter(f => matchesSelectedTags(f.key)), [files, matchesSelectedTags])

  const toggleTagFilter = useCallback((tagId: string) => {
    setSelectedTagIds(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
      return next
    })
  }, [])
```

続けて、既存の `const isEmpty = ...` 以下の行を `visibleDirs`/`visibleFiles` を使うように書き換える:
```typescript
  const isEmpty = !loading && visibleDirs.length === 0 && visibleFiles.length === 0
```
(元は `dirs.length === 0 && files.length === 0` — フィルタ適用後の空表示に合わせる)

JSX の `<EntryTable ...>` 呼び出しを差し替え、直前に `<TagFilterBar>` を追加する:
```tsx
        <TagFilterBar
          tags={filterCandidates}
          selected={selectedTagIds}
          onToggle={toggleTagFilter}
          onClear={() => setSelectedTagIds(new Set())}
        />
        <EntryTable
          dirs={visibleDirs}
          files={visibleFiles}
          prefix={prefix}
          connId={connId}
          bucket={bucket}
          onSelectFile={onSelectFile}
          allTags={allTags}
          tagsByPath={tagsByPath}
          onTagsChange={handleTagsChange}
        />
```

`Pager` の `entryCount` は絞り込み後の件数を見せる (S3 側のページングは変わらないので `dirs.length + files.length` のままにする — 絞り込みは表示のみで取得ページ数には影響しない。**変更しない**)。

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `cd front && npm test -- StorageBrowser`
Expected: PASS (`StorageBrowser.tags.test.tsx` の 2 件、既存 `StorageBrowser.test.tsx` も PASS)

- [ ] **Step 9: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 10: Commit**

```bash
git add front/components/storage/TagFilterBar.tsx front/components/storage/TagFilterBar.test.tsx \
        front/components/StorageBrowser.tsx front/components/StorageBrowser.tags.test.tsx
git commit -m "feat(front): StorageBrowser にタグ取得・絞り込みを組み込む"
```

---

## Task 10: フロント — `StorageIndex` (バケット一覧) へのバッジ・絞り込みの組み込み

**Files:**
- Modify: `front/pages/StorageIndex.tsx`
- Create: `front/pages/StorageIndex.tags.test.tsx`

**Interfaces:**
- Consumes: `TagBadge`/`TagPicker`/`TagFilterBar` (Task 6, 7, 9)、`api.tags()`/`api.tagAssignments()` (Task 5)。
- Produces: `StorageIndex` の `BucketLi` にタグバッジ + 編集導線、一覧全体にタグ絞り込みを追加。Task 11 が同じページに `TagSearchPanel` を積む。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/pages/StorageIndex.tags.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import StorageIndex from './StorageIndex'

afterEach(() => vi.restoreAllMocks())

describe('StorageIndex タグ', () => {
  it('バケット行にタグバッジを表示する', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'bkt-1', creationDate: null }] })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockResolvedValue({ 'bkt-1': ['t1'] })
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(<MemoryRouter><StorageIndex connId="c1" /></MemoryRouter>)
    expect(await screen.findByText('重要')).toBeInTheDocument()
  })

  it('タグチップで絞り込むと一致しないバケットが隠れる', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({
      buckets: [{ name: 'bkt-1', creationDate: null }, { name: 'bkt-2', creationDate: null }],
    })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockResolvedValue({ 'bkt-1': ['t1'] })
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(<MemoryRouter><StorageIndex connId="c1" /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())
    expect(screen.getByText('bkt-2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重要' }))

    expect(screen.getByText('bkt-1')).toBeInTheDocument()
    expect(screen.queryByText('bkt-2')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- StorageIndex.tags`
Expected: FAIL

- [ ] **Step 3: StorageIndex.tsx を修正する**

import に追記:
```typescript
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Link} from 'react-router-dom'
import {api} from '../lib/api/client'
import {ConnectionSwitcher} from '../components/ConnectionSwitcher'
import {ReadmeSearchPanel} from '../components/ReadmeSearchPanel'
import {S3PathPanel} from '../components/S3PathPanel'
import {CacheMeta} from '../components/CacheMeta'
import {TagBadge} from '../components/TagBadge'
import {TagPicker} from '../components/TagPicker'
import {TagFilterBar} from '../components/storage/TagFilterBar'
import type {Tag} from '../lib/api/types'
```
(既存の `useCallback, useEffect, useState` に `useMemo` を追加)

`StorageIndex` 本体、既存の `refresh`/`forceRefresh` の下にタグ用の state・effect・絞り込みロジックを追加:
```typescript
    const [allTags, setAllTags] = useState<Tag[]>([])
    const [bucketTags, setBucketTags] = useState<Record<string, string[]>>({})
    const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => new Set())

    useEffect(() => { api.tags().then(setAllTags).catch(() => {}) }, [connId])

    // storage_tag_assignments は (connection_id, bucket, target_kind, target_path) で
    // 一意 — kind='bucket' の対象は「bucket カラムそのもの」で path は常に '' (Task 3)。
    // つまりここで欲しいのは「複数バケットそれぞれの kind='bucket' タグ」であり、
    // api.tagAssignments(connId, bucket, kind, paths) の「1 bucket 固定 + 複数 path の
    // バッチ」という軸とは合わない。bucket 数ぶん並列 Promise.all で取得する
    // (ラボ規模の bucket 数を想定。数百件規模になったら bucket 複数対応の別モードを検討)。
    useEffect(() => {
        let cancelled = false
        Promise.all(buckets.map(b =>
            api.tagAssignments(connId, b.name, 'bucket', ['']).then(m => [b.name, m[''] ?? []] as const),
        )).then(entries => {
            if (!cancelled) setBucketTags(Object.fromEntries(entries))
        }).catch(() => {})
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, buckets.map(b => b.name).join(' ')])

    const handleTagsChange = useCallback((bucketName: string, tagIds: string[]) => {
        setBucketTags(prev => ({ ...prev, [bucketName]: tagIds }))
    }, [])

    const visibleTagIds = useMemo(() => new Set(Object.values(bucketTags).flat()), [bucketTags])
    const filterCandidates = useMemo(
        () => allTags.filter(t => visibleTagIds.has(t.id)),
        [allTags, visibleTagIds],
    )
    const toggleTagFilter = useCallback((tagId: string) => {
        setSelectedTagIds(prev => {
            const next = new Set(prev)
            if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
            return next
        })
    }, [])
    const matchesSelectedTags = useCallback((bucketName: string): boolean => {
        if (selectedTagIds.size === 0) return true
        const ids = bucketTags[bucketName] ?? []
        return ids.some(id => selectedTagIds.has(id))
    }, [selectedTagIds, bucketTags])
```

`BucketLi` を書き換え、タグバッジ + 編集導線を追加する:
```typescript
function BucketLi({
                      connId, bucket, inUse, onToggle, allTags, tagIds, onTagsChange,
                  }: {
    connId: string; bucket: BucketRow; inUse: boolean; onToggle: () => void
    allTags: Tag[]; tagIds: string[]; onTagsChange: (bucketName: string, tagIds: string[]) => void
}) {
    const [pickerOpen, setPickerOpen] = useState(false)
    const checkboxId = `use-${bucket.name}`
    const tags = allTags.filter(t => tagIds.includes(t.id))
    return (
        <li className={liClass} style={{borderBottom: '1px solid var(--rule)'}}>
            <label
                className="use-toggle"
                htmlFor={checkboxId}
                title={inUse ? '使用中から外す' : '現在使っているバケットに追加'}
            >
                <input
                    id={checkboxId}
                    type="checkbox"
                    checked={inUse}
                    onChange={onToggle}
                    aria-label={`${bucket.name} を現在使っているバケットに${inUse ? '外す' : '追加'}`}
                />
            </label>
            <Link
                className={linkClass}
                to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(bucket.name)}/`}
            >
                {bucket.name}
            </Link>
            {tags.map(t => <TagBadge key={t.id} tag={t} />)}
            {bucket.creationDate && (
                <span
                    className="font-mono text-[11.5px] text-ink-7 shrink-0"
                    style={{letterSpacing: '0.01em'}}
                >
          {bucket.creationDate.slice(0, 10)}
        </span>
            )}
            <button type="button" className="ghost shrink-0" onClick={() => setPickerOpen(true)} aria-label="タグを編集">
                <span aria-hidden>🏷</span>
            </button>
            {pickerOpen && (
                <TagPicker
                    connId={connId} bucket={bucket.name} kind="bucket" path="" label={bucket.name}
                    allTags={allTags} assignedTagIds={tagIds}
                    onChange={next => onTagsChange(bucket.name, next)}
                    onClose={() => setPickerOpen(false)}
                />
            )}
        </li>
    )
}
```

`favoriteRows`/`otherRows` の算出は変わらないが、**表示直前に絞り込みを通す**。`favoriteRows`/`otherRows` を計算しているループの後に追記:
```typescript
    const visibleFavoriteRows = favoriteRows.filter(b => matchesSelectedTags(b.name))
    const visibleOtherRows = otherRows.filter(b => matchesSelectedTags(b.name))
```

JSX を `favoriteRows`/`otherRows` → `visibleFavoriteRows`/`visibleOtherRows` に差し替え、`<ReadmeSearchPanel connId={connId}/>` の下に `<TagFilterBar>` を追加:
```tsx
            <ReadmeSearchPanel connId={connId}/>
            <TagFilterBar
                tags={filterCandidates}
                selected={selectedTagIds}
                onToggle={toggleTagFilter}
                onClear={() => setSelectedTagIds(new Set())}
            />
            <S3PathPanel connId={connId}/>
```
そして `favoriteRows.map(...)` / `otherRows.map(...)` を `visibleFavoriteRows.map(...)` / `visibleOtherRows.map(...)` に変更し、`BucketLi` 呼び出しに `allTags={allTags} tagIds={bucketTags[b.name] ?? []} onTagsChange={handleTagsChange}` を追加する。`favoriteRows.length > 0` / `otherRows.length > 0` の条件分岐も `visibleFavoriteRows.length > 0` / `visibleOtherRows.length > 0` に変更する。

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- StorageIndex`
Expected: PASS (`StorageIndex.tags.test.tsx` の 2 件。既存の `StorageLanding.test.tsx` など関連テストも PASS)

- [ ] **Step 5: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 6: Commit**

```bash
git add front/pages/StorageIndex.tsx front/pages/StorageIndex.tags.test.tsx
git commit -m "feat(front): StorageIndex (バケット一覧) にタグ表示・絞り込みを組み込む"
```

---

## Task 11: フロント — `TagSearchPanel` (接続内横断検索)

**Files:**
- Create: `front/components/TagSearchPanel.tsx`
- Create: `front/components/TagSearchPanel.test.tsx`
- Modify: `front/pages/StorageIndex.tsx`

**Interfaces:**
- Consumes: `api.tags()` / `api.tagSearch()` (Task 5)、`TagBadge` (Task 6)、`encPath`/`fileLinkToDirRedirect` (`front/lib/route.ts`、既存)。
- Produces: `TagSearchPanel({ connId }: { connId: string }): JSX.Element` — `StorageIndex` にマウントする。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/components/TagSearchPanel.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { TagSearchPanel } from './TagSearchPanel'

afterEach(() => vi.restoreAllMocks())

describe('TagSearchPanel', () => {
  it('タグを選ぶと接続内横断検索を実行し、結果へのリンクを表示する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt-1', kind: 'bucket', path: '' },
      { tagId: 't1', bucket: 'bkt-2', kind: 'prefix', path: 'dir/' },
      { tagId: 't1', bucket: 'bkt-2', kind: 'file', path: 'dir/file.txt' },
    ])

    render(<MemoryRouter><TagSearchPanel connId="c1" /></MemoryRouter>)
    const chip = await screen.findByRole('button', { name: '重要' })
    fireEvent.click(chip)

    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())
    expect(screen.getByText('bkt-2')).toBeInTheDocument()
    expect(screen.getByText('dir/')).toBeInTheDocument()
    expect(screen.getByText('dir/file.txt')).toBeInTheDocument()

    const bucketLink = screen.getByText('bkt-1').closest('a')
    expect(bucketLink).toHaveAttribute('href', '/storage/c1/bkt-1/')
  })

  it('タグ未選択なら検索は走らない', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    const searchSpy = vi.spyOn(api, 'tagSearch')
    render(<MemoryRouter><TagSearchPanel connId="c1" /></MemoryRouter>)
    await screen.findByRole('button', { name: '重要' })
    expect(searchSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- TagSearchPanel`
Expected: FAIL (`Cannot find module './TagSearchPanel'`)

- [ ] **Step 3: 実装する**

```tsx
// front/components/TagSearchPanel.tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Tag, TagSearchResult } from '../lib/api/types'
import { encPath, fileLinkToDirRedirect } from '../lib/route'
import { TagBadge } from './TagBadge'

interface Props {
  connId: string
}

type Hit = TagSearchResult[number]

function hrefFor(connId: string, hit: Hit): string {
  if (hit.kind === 'bucket') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/`
  }
  if (hit.kind === 'prefix') {
    return `/storage/${encodeURIComponent(connId)}/${encodeURIComponent(hit.bucket)}/${encPath(hit.path)}`
  }
  return fileLinkToDirRedirect(connId, hit.bucket, hit.path)
}

// ReadmeSearchPanel と同じ位置 (StorageIndex 上部) に置く、タグの接続内横断検索。
// 選んだタグのいずれかが付いた bucket/ディレクトリ/ファイルを列挙する (OR)。
export function TagSearchPanel({ connId }: Props) {
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [hits, setHits] = useState<TagSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelected(new Set())
    setHits(null)
    api.tags().then(setAllTags).catch(() => {})
  }, [connId])

  useEffect(() => {
    if (selected.size === 0) {
      setHits(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api.tagSearch(connId, [...selected])
      .then(r => { if (!cancelled) setHits(r) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [connId, selected])

  const toggle = (tagId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId); else next.add(tagId)
      return next
    })
  }

  if (allTags.length === 0) return null

  return (
    <section className="mt-3 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">
          タグで横断検索
        </span>
        {allTags.map(tag => (
          <button
            key={tag.id}
            type="button"
            onClick={() => toggle(tag.id)}
            className="border-0 bg-transparent p-0 cursor-pointer"
            style={{ opacity: selected.size === 0 || selected.has(tag.id) ? 1 : 0.4 }}
            aria-pressed={selected.has(tag.id)}
          >
            <TagBadge tag={tag} />
          </button>
        ))}
        {loading && <span className="text-[11px] text-ink-7">検索中…</span>}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      {hits !== null && hits.length === 0 && !loading && !error && (
        <p className="mt-3 text-[12px] text-ink-7">ヒットなし。</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="m-0 mt-3 list-none p-0" style={{ borderTop: '1px solid var(--rule)' }}>
          {hits.map(h => (
            <li
              key={`${h.tagId}|${h.bucket}|${h.kind}|${h.path}`}
              className="py-2.5 px-1 transition-colors hover:bg-ink-0"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <Link to={hrefFor(connId, h)} className="block text-ink-12 no-underline">
                <span
                  className="text-[12.5px] text-ink-7"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                >
                  {h.bucket}/
                </span>
                <span
                  className="text-[12.5px] font-medium text-ink-12"
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.005em' }}
                >
                  {h.kind === 'bucket' ? '(bucket root)' : h.path}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- TagSearchPanel`
Expected: PASS (2 tests)

- [ ] **Step 5: StorageIndex.tsx にマウントする**

`front/pages/StorageIndex.tsx` の import に追記:
```typescript
import {TagSearchPanel} from '../components/TagSearchPanel'
```
`<ReadmeSearchPanel connId={connId}/>` の直後に追加:
```tsx
            <ReadmeSearchPanel connId={connId}/>
            <TagSearchPanel connId={connId}/>
            <TagFilterBar
```

- [ ] **Step 6: StorageIndex のテストを再実行して壊れていないことを確認する**

Run: `cd front && npm test -- StorageIndex`
Expected: PASS (Task 10 のテスト + 既存テストとも通る。`api.tags`/`api.tagSearch` は個々のテストで spy されていない呼び出しに対して実 fetch を試みず reject する場合があるため、既存の `StorageIndex.tags.test.tsx` / `StorageLanding.test.tsx` で `api.tagSearch` が未 mock のままだと `TagSearchPanel` 内の `useEffect` が空配列 selected のままなら `tagSearch` を呼ばないので問題ない。`api.tags` は Task 10 のテストで既に spy 済み)

- [ ] **Step 7: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 8: Commit**

```bash
git add front/components/TagSearchPanel.tsx front/components/TagSearchPanel.test.tsx front/pages/StorageIndex.tsx
git commit -m "feat(front): タグの接続内横断検索パネルを追加"
```

---

## Task 12: フロント — `TagsSettings` (Settings でのタグ管理)

**Files:**
- Create: `front/components/TagsSettings.tsx`
- Create: `front/components/TagsSettings.test.tsx`
- Modify: `front/pages/ConnectionsPage.tsx`

**Interfaces:**
- Consumes: `api.tags()`/`api.createTag()`/`api.updateTag()`/`api.deleteTag()` (Task 5)、`TagBadge` (Task 6)。
- Produces: `TagsSettings(): JSX.Element` — `ConnectionsPage` にマウントする。他タスクからの依存なし (最終タスク)。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// front/components/TagsSettings.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { TagsSettings } from './TagsSettings'

afterEach(() => vi.restoreAllMocks())

describe('TagsSettings', () => {
  it('登録済みタグの一覧を表示する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    render(<TagsSettings />)
    expect(await screen.findByText('重要')).toBeInTheDocument()
  })

  it('「+ 追加」でフォームを開き、保存すると createTag を呼ぶ', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'createTag').mockResolvedValue({ id: 't1', name: '新規', color: '#123456' })
    render(<TagsSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /追加/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /追加/ }))
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '新規' } })
    fireEvent.change(screen.getByLabelText('色'), { target: { value: '#123456' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ name: '新規', color: '#123456' }))
  })

  it('削除ボタン → 確認モーダルで確定すると deleteTag を呼ぶ', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    const deleteSpy = vi.spyOn(api, 'deleteTag').mockResolvedValue(undefined)
    render(<TagsSettings />)
    await screen.findByText('重要')

    fireEvent.click(screen.getByRole('button', { name: '重要 を削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('t1'))
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npm test -- TagsSettings`
Expected: FAIL (`Cannot find module './TagsSettings'`)

- [ ] **Step 3: 実装する**

```tsx
// front/components/TagsSettings.tsx
import { useEffect, useReducer } from 'react'
import { api } from '../lib/api/client'
import type { Tag } from '../lib/api/types'
import { TagBadge } from './TagBadge'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

interface State {
  tags: Tag[]
  loading: boolean
  error: string | null
  adding: boolean
  editing: Tag | null
  deleting: Tag | null
}

type Action =
  | { type: 'loadOk'; tags: Tag[] }
  | { type: 'loadErr'; error: string }
  | { type: 'openAdd' }
  | { type: 'openEdit'; tag: Tag }
  | { type: 'openDelete'; tag: Tag }
  | { type: 'closeModal' }

const initial: State = { tags: [], loading: true, error: null, adding: false, editing: null, deleting: null }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'loadOk':    return { ...s, loading: false, tags: a.tags }
    case 'loadErr':   return { ...s, loading: false, error: a.error }
    case 'openAdd':   return { ...s, adding: true }
    case 'openEdit':  return { ...s, editing: a.tag }
    case 'openDelete':return { ...s, deleting: a.tag }
    case 'closeModal':return { ...s, adding: false, editing: null, deleting: null }
  }
}

// 新規作成・編集共通の小さいインラインフォーム (2 フィールドのみなので
// ConnectionForm のような別ファイルには分けない)。
function TagForm({
  initialValue, onSubmit, onCancel,
}: {
  initialValue: { name: string; color: string }
  onSubmit: (v: { name: string; color: string }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useReducer((_: string, v: string) => v, initialValue.name)
  const [color, setColor] = useReducer((_: string, v: string) => v, initialValue.color)
  const [saving, setSaving] = useReducer((_: boolean, v: boolean) => v, false)
  const [error, setError] = useReducer((_: string | null, v: string | null) => v, null)

  const submit = async () => {
    if (!name.trim()) { setError('名前を入力してください'); return }
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ name: name.trim(), color })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="tag-form-title">
        <p className="kicker">Settings · タグ</p>
        <h3 id="tag-form-title">{initialValue.name ? 'タグを編集' : 'タグを追加'}</h3>
        <label className="modal-field">
          <span className="label">名前</span>
          <input value={name} onChange={e => setName(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <label className="modal-field">
          <span className="label">色</span>
          <input type="color" value={color} onChange={e => setColor(e.target.value)} />
        </label>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={saving}>キャンセル</button>
          <button onClick={submit} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}

function DeleteConfirm({
  tag, onConfirm, onCancel,
}: { tag: Tag; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useReducer((_: boolean, v: boolean) => v, false)
  const [error, setError] = useReducer((_: string | null, v: string | null) => v, null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="tag-delete-title">
        <p className="kicker">Settings · タグ · 削除</p>
        <h3 id="tag-delete-title">タグを削除</h3>
        <p className="text-[14px] leading-relaxed text-ink-9">
          タグ「{tag.name}」を削除します。全ての割り当ても消えます。よろしいですか?
        </p>
        {error && <p className="error" aria-live="polite">{error}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>キャンセル</button>
          <button
            onClick={submit}
            disabled={busy}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--paper)' }}
          >
            {busy ? '削除中…' : '削除'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function TagsSettings() {
  const [state, dispatch] = useReducer(reducer, initial)
  const { tags, loading, error, adding, editing, deleting } = state

  const refresh = () => {
    api.tags().then(tags => dispatch({ type: 'loadOk', tags })).catch((e: Error) => dispatch({ type: 'loadErr', error: e.message }))
  }
  useEffect(() => { refresh() }, [])

  return (
    <section className="mt-7">
      <div
        className="mb-3 flex items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <h3 className={sectionTitleClass}>タグの管理</h3>
        <button className="ghost" onClick={() => dispatch({ type: 'openAdd' })}>
          <span aria-hidden>+</span> 追加
        </button>
      </div>

      {loading && <p className="text-[13px] text-ink-7">読み込み中…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && tags.length === 0 && (
        <p className="text-[13px] text-ink-7">まだタグがありません。</p>
      )}

      {tags.length > 0 && (
        <ul className="m-0 list-none p-0">
          {tags.map(tag => (
            <li
              key={tag.id}
              className="flex items-center justify-between gap-3 py-2.5"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <TagBadge tag={tag} />
              <span className="flex gap-2">
                <button className="ghost" onClick={() => dispatch({ type: 'openEdit', tag })}>編集</button>
                <button
                  className="ghost"
                  aria-label={`${tag.name} を削除`}
                  onClick={() => dispatch({ type: 'openDelete', tag })}
                >
                  削除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <TagForm
          initialValue={{ name: '', color: '#888888' }}
          onSubmit={async v => { await api.createTag(v); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
      {editing && (
        <TagForm
          initialValue={{ name: editing.name, color: editing.color }}
          onSubmit={async v => { await api.updateTag(editing.id, v); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
      {deleting && (
        <DeleteConfirm
          tag={deleting}
          onConfirm={async () => { await api.deleteTag(deleting.id); dispatch({ type: 'closeModal' }); refresh() }}
          onCancel={() => dispatch({ type: 'closeModal' })}
        />
      )}
    </section>
  )
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `cd front && npm test -- TagsSettings`
Expected: PASS (3 tests)

- [ ] **Step 5: ConnectionsPage.tsx にマウントする**

`front/pages/ConnectionsPage.tsx` の import に追記:
```typescript
import { TagsSettings } from '../components/TagsSettings'
```
`</section>` (「オブジェクトストレージ接続先の管理」セクションの閉じタグ) の直後、`About` の前に追加:
```tsx
      <TagsSettings />

      <About />
```
(実際の `About` 呼び出し行の位置は `ConnectionsPage.tsx` を直接確認して合わせる — 「オブジェクトストレージ接続先の管理」セクションの次、末尾の `About` セクションの前に挿入する)

- [ ] **Step 6: テストを実行して通ることを確認する**

Run: `cd front && npm test -- ConnectionsPage`
Expected: PASS (既存テストが壊れていないことを確認)

- [ ] **Step 7: 型チェックと lint を確認する**

Run: `cd front && npx tsc -b --noEmit && npm run lint`
Expected: エラーなく完了する

- [ ] **Step 8: Commit**

```bash
git add front/components/TagsSettings.tsx front/components/TagsSettings.test.tsx front/pages/ConnectionsPage.tsx
git commit -m "feat(front): Settings にタグ管理セクション (TagsSettings) を追加"
```

---

## Task 13: 最終確認

**Files:** なし (検証のみ)

**Interfaces:** なし

- [ ] **Step 1: バックエンド全体のテスト・lint・ビルドを実行する**

Run: `cd api && npm test && npm run lint && npm run build`
Expected: 全て PASS

- [ ] **Step 2: フロント全体のテスト・lint・ビルドを実行する**

Run: `cd front && npm test && npm run lint && npm run build`
Expected: 全て PASS

- [ ] **Step 3: dev 環境で手動確認する**

Run: `docker compose -f compose.dev.yaml up -d --build`

ブラウザで `http://localhost:5173` を開き:
1. Settings → タグの管理 で新規タグ (例: 「重要」赤) を作成できる
2. Storage → バケット一覧の行でバッジが表示され、行の 🏷 からタグを付け外しできる
3. あるバケットに入り、ディレクトリ/ファイル行の ⋯ → 「タグを編集」でタグを付け外しできる
4. 一覧上部の「タグで絞り込み」チップで絞り込みが効く
5. バケット一覧の「タグで横断検索」で、複数バケットに跨って付けたタグが横断的に見つかる
6. タグを削除すると、それが付いていた行からバッジが消える

Expected: 上記が全て問題なく動作する

- [ ] **Step 4: Commit は不要 (検証のみ)**

前タスクまでの commit で機能は完結している。
