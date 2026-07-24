# データの家系図（親子リンク・家系図ビュー） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bucket / directory / file を問わず任意のノードに手動で親子リンク（データの由来）を登録でき、`StorageBucket` 画面から「家系図」タブとして辿れる機能を追加する。

**Architecture:** Postgres に1テーブル (`storage_lineage_links`, エッジのみ) を追加し、`storage-favorites.ts` と同じ LAN 共有・認証なしの Hono ルートで CRUD する。フロントは全エッジを1回で取得し、表示スコープ（全て/バケット単位/現在地）の絞り込み・集約は純関数（`front/lib/lineageGraph.ts`）でクライアント側に行う。UI は `StorageBucket` に「一覧/家系図」タブを追加し、専用タブ内でグラフ・ノードクリックのポップアップ・リンク追加ピッカーを表示する。

**Tech Stack:** Hono (API), node-pg, zod, React 19 + react-router-dom, vitest + @testing-library/react。既存パターン踏襲のみで新規ライブラリは追加しない。

**参照仕様書:** `docs/superpowers/specs/2026-07-24-data-lineage-graph-design.md`

## Global Constraints

- LAN 共有・認証なし。README / Notes / Favorites と同じ「オナーシステム、防御は LAN 境界に委ねる」を踏襲する（`api/routes/storage-favorites.ts` のコメント参照）。
- 親子リンクは同一 `connection_id` 内のみ（bucket をまたいでよいが connection はまたがない）。
- 新規 TS/TSX ファイルは既存の prettier 設定に従う: セミコロンなし・シングルクォート・末尾カンマあり（`.prettierrc.json`: `semi:false, singleQuote:true, trailingComma:"all"`）。
- DB migration は `db/migrations/NNN_....sql` の連番。既存最大は `009_media_meta.sql` → 新規は `010_storage_lineage_links.sql`。各 migration ファイルは自己完結（`CREATE TABLE IF NOT EXISTS` + 末尾で `OWNER TO dashboard_rw` / `GRANT SELECT ... TO dashboard_ro`）。
- API ルートは `api/routes/*.ts` に1ファイル、`mountXxxRoutes(app, deps)` の形で export し、`api/internal.ts` でマウントする。
- フロント API クライアントは `front/lib/api/client.ts` の `api` オブジェクトに関数を足し、型は `front/lib/api/types.ts` に zod スキーマとして定義する（`getJson`/`mutateJson` ヘルパーと `TTLCache` を再利用する）。
- 新規コンポーネントは `front/components/storage/lineage/` に置く。モーダルは既存の `.modal-backdrop` / `.modal` CSS 基底クラス（`front/App.css`）を使う。

## File Structure

**Backend:**
- `db/migrations/010_storage_lineage_links.sql` — 新規。エッジテーブル。
- `api/routes/storage-lineage.ts` — 新規。GET/POST/DELETE ハンドラ。
- `api/routes/storage-lineage.test.ts` — 新規。
- `api/internal.ts` — 変更。新ルートをマウント。

**Frontend — lib:**
- `front/lib/api/types.ts` — 変更。`LineageLink` / `LineageLinks` / `PostLineageLinkOk` zod スキーマを追加。
- `front/lib/api/client.ts` — 変更。`lineageLinks` / `addLineageLink` / `removeLineageLink` / `invalidateLineageLinks` を追加。
- `front/lib/api/lineage-client.test.ts` — 新規。
- `front/lib/lineageGraph.ts` — 新規。ノード識別・祖先/子孫トラバーサル・バケット集約の純関数群。
- `front/lib/lineageGraph.test.ts` — 新規。

**Frontend — components:**
- `front/components/storage/lineage/LineageNodePopup.tsx` — 新規。ノードクリック時の小さいポップアップ（README/プレビュー埋め込み + 直接の親子一覧 + 解除 + 移動）。
- `front/components/storage/lineage/LineageNodePopup.test.tsx` — 新規。
- `front/components/storage/lineage/LineageGraphCanvas.tsx` — 新規。ノード/エッジの描画（プレゼンテーショナル）。
- `front/components/storage/lineage/LineageGraphCanvas.test.tsx` — 新規。
- `front/components/storage/lineage/LineageLinkPicker.tsx` — 新規。リンク追加時の相手ノード選択モーダル。
- `front/components/storage/lineage/LineageLinkPicker.test.tsx` — 新規。
- `front/components/storage/lineage/LineageView.tsx` — 新規。上記3つを束ねるオーケストレーター（フェッチ・スコープ切替・追加/解除フロー）。
- `front/components/storage/lineage/LineageView.test.tsx` — 新規。
- `front/pages/StorageBucket.tsx` — 変更。「一覧/家系図」タブと `?view=lineage` を追加。
- `front/pages/StorageBucket.test.tsx` — 新規。
- `front/App.css` — 変更。上記コンポーネント用の CSS を追加。

---

### Task 1: DB migration — `storage_lineage_links`

**Files:**
- Create: `db/migrations/010_storage_lineage_links.sql`

**Interfaces:**
- Produces: テーブル `storage_lineage_links(id, connection_id, parent_bucket, parent_path, child_bucket, child_path, created_by, created_at)`。Task 2 のルートハンドラがこのカラム名で読み書きする。

- [ ] **Step 1: migration ファイルを書く**

```sql
-- データの家系図（親子リンク）。bucket/directory/file を任意にノード化し、
-- 手動登録の親子エッジだけを持つ (spec: 2026-07-24-data-lineage-graph-design.md)。
-- ノード自体はテーブルを持たず (bucket, path) の組がそのまま識別子になる。
-- path === '' はバケット直下、末尾 '/' はディレクトリ、それ以外はファイル key。

CREATE TABLE IF NOT EXISTS storage_lineage_links (
  id            BIGSERIAL   PRIMARY KEY,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  parent_bucket TEXT        NOT NULL,
  parent_path   TEXT        NOT NULL,
  child_bucket  TEXT        NOT NULL,
  child_path    TEXT        NOT NULL,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((parent_bucket, parent_path) IS DISTINCT FROM (child_bucket, child_path)),
  UNIQUE (connection_id, parent_bucket, parent_path, child_bucket, child_path)
);

CREATE INDEX IF NOT EXISTS storage_lineage_links_conn_idx
  ON storage_lineage_links (connection_id);

CREATE INDEX IF NOT EXISTS storage_lineage_links_parent_idx
  ON storage_lineage_links (connection_id, parent_bucket, parent_path);

CREATE INDEX IF NOT EXISTS storage_lineage_links_child_idx
  ON storage_lineage_links (connection_id, child_bucket, child_path);

ALTER TABLE    storage_lineage_links         OWNER TO dashboard_rw;
ALTER SEQUENCE storage_lineage_links_id_seq  OWNER TO dashboard_rw;
GRANT SELECT ON storage_lineage_links TO dashboard_ro;
```

- [ ] **Step 2: ローカルの dev / test DB に適用する**

`compose.dev.yaml` で Postgres が起動している前提（`docker compose -f compose.dev.yaml up -d`）。00-init.sh はコンテナ初回作成時にしか走らないので、002〜009 と同様に手動で流す。

```bash
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d dashboard -f - < db/migrations/010_storage_lineage_links.sql
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d dashboard_test -f - < db/migrations/010_storage_lineage_links.sql
```

Expected: 両方とも `CREATE TABLE` / `CREATE INDEX` がエラーなく出力される。

- [ ] **Step 3: テーブルが見えることを確認する**

```bash
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d dashboard_test -c "\d storage_lineage_links"
```

Expected: カラム一覧と `Check constraints`, `Indexes` が表示される。

- [ ] **Step 4: commit**

```bash
git add db/migrations/010_storage_lineage_links.sql
git commit -m "feat: データの家系図用に storage_lineage_links テーブルを追加する"
```

---

### Task 2: Backend API ルート — `storage-lineage.ts`

**Files:**
- Create: `api/routes/storage-lineage.ts`
- Create: `api/routes/storage-lineage.test.ts`
- Modify: `api/internal.ts`

**Interfaces:**
- Consumes: `Pools`（`api/db.ts`）、Task 1 のテーブル。
- Produces:
  - `mountStorageLineageRoutes(app: Hono, deps: { pools: Pools }): void`
  - `GET  /storage/:connId/lineage-links` → `200` + `Array<{id:number, parentBucket:string, parentPath:string, childBucket:string, childPath:string, createdBy:string, createdAt:string}>`
  - `POST /storage/:connId/lineage-links` body `{parent:{bucket,path}, child:{bucket,path}, editor}` → `200` + `{ok:true, id:number}` / `400` on invalid body or self-link
  - `DELETE /storage/:connId/lineage-links/:id` → `200` + `{ok:true}`（存在しない id でも冪等に 200）

- [ ] **Step 1: 失敗するテストを書く**

`api/routes/storage-lineage.test.ts`:

```ts
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageLineageRoutes } from './storage-lineage.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountStorageLineageRoutes(app, { pools })

const TEST_CONN_ID = 'testconn01'
const OTHER_CONN_ID = 'otherconn1'

async function seedConnection(p: Pools, id: string): Promise<void> {
  await p.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, 'https://test.example/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…XYZ4', true)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

beforeEach(async () => {
  // CASCADE で storage_lineage_links も削除される。
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await seedConnection(pools, TEST_CONN_ID)
  await seedConnection(pools, OTHER_CONN_ID)
})
afterAll(() => closePools(pools))

const parent = { bucket: 'raw', path: '2024-01/' }
const child = { bucket: 'clean', path: 'v2/' }

describe('storage lineage links', () => {
  it('GET returns empty array by default', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST creates a link and GET returns it', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: true; id: number }
    expect(body.ok).toBe(true)
    expect(typeof body.id).toBe('number')

    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json()
    expect(list).toEqual([{
      id: body.id,
      parentBucket: 'raw', parentPath: '2024-01/',
      childBucket: 'clean', childPath: 'v2/',
      createdBy: 'aida', createdAt: expect.any(String),
    }])
  })

  it('POST is idempotent (same pair twice -> one row, same id)', async () => {
    const first = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })).json() as { id: number }

    const second = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'someone-else' }),
    })).json() as { id: number }

    expect(second.id).toBe(first.id)
    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json() as unknown[]
    expect(list).toHaveLength(1)
  })

  it('POST rejects a self-link (parent === child)', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child: parent, editor: 'aida' }),
    })
    expect(res.status).toBe(400)
  })

  it('DELETE removes the link', async () => {
    const created = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })).json() as { id: number }

    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json()
    expect(list).toEqual([])
  })

  it('DELETE on missing id is idempotent', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links/999999`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('links are scoped per-connection', async () => {
    await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })
    await app.request(`/storage/${OTHER_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { bucket: 'x', path: '' }, child: { bucket: 'y', path: '' }, editor: 'aida' }),
    })
    const a = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json() as unknown[]
    const b = await (await app.request(`/storage/${OTHER_CONN_ID}/lineage-links`)).json() as unknown[]
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd api && npx vitest run routes/storage-lineage.test.ts`
Expected: FAIL — `Cannot find module './storage-lineage.js'`

- [ ] **Step 3: ルートハンドラを実装する**

`api/routes/storage-lineage.ts`:

```ts
import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// LAN 共有: README / favorites と同じオナーシステム。認証なし、防御は LAN 境界に委ねる。

export interface StorageLineageDeps {
  pools: Pools
}

const NodeRef = z.object({
  bucket: z.string().min(1),
  path: z.string(),
})

const PostBody = z.object({
  parent: NodeRef,
  child: NodeRef,
  editor: z.string().min(1),
})

const LINK_COLUMNS = `
  id,
  parent_bucket AS "parentBucket",
  parent_path   AS "parentPath",
  child_bucket  AS "childBucket",
  child_path    AS "childPath",
  created_by    AS "createdBy",
  created_at    AS "createdAt"
`

export function mountStorageLineageRoutes(app: Hono, deps: StorageLineageDeps): void {
  app.get('/storage/:connId/lineage-links', async c => {
    const connId = c.req.param('connId')
    const r = await deps.pools.ro.query(
      `SELECT ${LINK_COLUMNS} FROM storage_lineage_links WHERE connection_id = $1 ORDER BY id`,
      [connId],
    )
    return c.json(r.rows)
  })

  app.post('/storage/:connId/lineage-links', async c => {
    const connId = c.req.param('connId')
    const parsed = PostBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const { parent, child, editor } = parsed.data
    if (parent.bucket === child.bucket && parent.path === child.path) {
      return c.json({ error: 'parent and child must differ' }, 400)
    }
    // ON CONFLICT DO NOTHING で重複登録を無害化しつつ、新規/既存いずれでも id を
    // 返す (フロントが「解除」ボタンへ即座に紐づける id を必要とするため)。
    // ins の INSERT と後段の SELECT は同じ statement 内の snapshot を共有するため
    // (Postgres の data-modifying CTE の仕様)、成功時は ins だけが 1 行返り、
    // 衝突時は後段の SELECT だけが 1 行返る — どちらの枝でも常にちょうど1行になる。
    const r = await deps.pools.rw.query(
      `WITH ins AS (
         INSERT INTO storage_lineage_links
           (connection_id, parent_bucket, parent_path, child_bucket, child_path, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, parent_bucket, parent_path, child_bucket, child_path)
         DO NOTHING
         RETURNING id
       )
       SELECT id FROM ins
       UNION ALL
       SELECT id FROM storage_lineage_links
        WHERE connection_id = $1 AND parent_bucket = $2 AND parent_path = $3
          AND child_bucket = $4 AND child_path = $5
        LIMIT 1`,
      [connId, parent.bucket, parent.path, child.bucket, child.path, editor],
    )
    return c.json({ ok: true, id: r.rows[0].id as number })
  })

  app.delete('/storage/:connId/lineage-links/:id', async c => {
    const connId = c.req.param('connId')
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    await deps.pools.rw.query(
      `DELETE FROM storage_lineage_links WHERE connection_id = $1 AND id = $2`,
      [connId, id],
    )
    return c.json({ ok: true })
  })
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd api && npx vitest run routes/storage-lineage.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: `api/internal.ts` にマウントする**

`api/internal.ts` の import 群に追加:

```ts
import { mountStorageLineageRoutes } from './routes/storage-lineage.js'
```

`mountStorageFavoritesRoutes(api, { pools })` の直後に追加:

```ts
mountStorageLineageRoutes(api, { pools })
```

- [ ] **Step 6: API 全体のテストを流す**

Run: `cd api && npm test`
Expected: PASS（全ファイル）

- [ ] **Step 7: commit**

```bash
git add api/routes/storage-lineage.ts api/routes/storage-lineage.test.ts api/internal.ts
git commit -m "feat: 家系図リンクの GET/POST/DELETE API を追加する"
```

---

### Task 3: フロント API 型・クライアント関数

**Files:**
- Modify: `front/lib/api/types.ts`
- Modify: `front/lib/api/client.ts`
- Create: `front/lib/api/lineage-client.test.ts`

**Interfaces:**
- Consumes: Task 2 の `GET/POST/DELETE /storage/:connId/lineage-links[...]` レスポンス形。
- Produces:
  - `LineageLink`（zod, 型）: `{id:number, parentBucket:string, parentPath:string, childBucket:string, childPath:string, createdBy:string, createdAt:string}`
  - `api.lineageLinks(connId: string): Promise<LineageLink[]>`
  - `api.invalidateLineageLinks(connId: string): void`
  - `api.addLineageLink(connId: string, parent: {bucket:string; path:string}, child: {bucket:string; path:string}, editor: string): Promise<number>`
  - `api.removeLineageLink(connId: string, id: number): Promise<void>`

- [ ] **Step 1: 型を追加する**

`front/lib/api/types.ts` の末尾に追加:

```ts
export const LineageLink = z.object({
  id: z.number(),
  parentBucket: z.string(),
  parentPath: z.string(),
  childBucket: z.string(),
  childPath: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export type LineageLink = z.infer<typeof LineageLink>
export const LineageLinks = z.array(LineageLink)

export const PostLineageLinkOk = z.object({ ok: z.literal(true), id: z.number() })
```

- [ ] **Step 2: 失敗するテストを書く**

`front/lib/api/lineage-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('lineage links client', () => {
  it('lineageLinks: URL を組み立てて zod でパースする', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([
      { id: 1, parentBucket: 'raw', parentPath: '2024-01/', childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-07-24T00:00:00Z' },
    ]))
    const r = await api.lineageLinks('c 1')
    expect(r).toHaveLength(1)
    expect(r[0].parentBucket).toBe('raw')
    expect(String(spy.mock.calls[0][0])).toBe('/api/internal/storage/c%201/lineage-links')
  })

  it('addLineageLink: body を POST し、返ってきた id を返す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ ok: true, id: 42 }))
    const id = await api.addLineageLink(
      'lc', { bucket: 'raw', path: '2024-01/' }, { bucket: 'clean', path: 'v2/' }, 'aida',
    )
    expect(id).toBe(42)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/lc/lineage-links')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      parent: { bucket: 'raw', path: '2024-01/' },
      child: { bucket: 'clean', path: 'v2/' },
      editor: 'aida',
    })
  })

  it('removeLineageLink: DELETE を id 付きで叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ ok: true }))
    await api.removeLineageLink('rc', 42)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/rc/lineage-links/42')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('lineageLinks はキャッシュされ、addLineageLink 後に再取得される', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ ok: true, id: 1 }))
      .mockResolvedValueOnce(okJson([{ id: 1, parentBucket: 'a', parentPath: '', childBucket: 'b', childPath: '', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z' }]))

    await api.lineageLinks('cache-test')
    await api.lineageLinks('cache-test') // キャッシュヒットなので fetch は増えない
    expect(spy).toHaveBeenCalledTimes(1)

    await api.addLineageLink('cache-test', { bucket: 'a', path: '' }, { bucket: 'b', path: '' }, 'x')
    const r = await api.lineageLinks('cache-test') // invalidate 済みなので再取得
    expect(spy).toHaveBeenCalledTimes(3)
    expect(r).toHaveLength(1)
  })
})
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `cd front && npx vitest run lib/api/lineage-client.test.ts`
Expected: FAIL — `api.lineageLinks is not a function`

- [ ] **Step 4: client.ts に実装する**

`front/lib/api/client.ts` の import 群 (`from './types'`) に `LineageLinks`, `PostLineageLinkOk` を追加。

キャッシュ群の宣言に追加（`favoritesCache` の直後）:

```ts
const lineageLinksCache = new TTLCache<z.infer<typeof LineageLinks>>(CACHE_TTL_MS)
```

`api` オブジェクト内、`removeFavorite` の直後に追加:

```ts
  lineageLinks: (connId: string) =>
    lineageLinksCache.get(k('lineage-links', connId), () =>
      getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/lineage-links`, LineageLinks),
    ),

  invalidateLineageLinks: (connId: string): void => {
    lineageLinksCache.invalidate(k('lineage-links', connId))
  },

  addLineageLink: async (
    connId: string,
    parent: { bucket: string; path: string },
    child: { bucket: string; path: string },
    editor: string,
  ): Promise<number> => {
    const res = await fetch(`${API_BASE}/storage/${encodeURIComponent(connId)}/lineage-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor }),
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const e = (await res.json()) as { error?: string }
        if (e.error) msg = e.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    const parsed = PostLineageLinkOk.parse(await res.json())
    lineageLinksCache.invalidate(k('lineage-links', connId))
    return parsed.id
  },

  removeLineageLink: async (connId: string, id: number): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/lineage-links/${id}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(res.statusText)
    lineageLinksCache.invalidate(k('lineage-links', connId))
  },
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run lib/api/lineage-client.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 6: commit**

```bash
git add front/lib/api/types.ts front/lib/api/client.ts front/lib/api/lineage-client.test.ts
git commit -m "feat: 家系図リンクの API クライアントを追加する"
```

---

### Task 4: `front/lib/lineageGraph.ts` — 純関数（ノード識別・トラバーサル・集約）

**Files:**
- Create: `front/lib/lineageGraph.ts`
- Create: `front/lib/lineageGraph.test.ts`

**Interfaces:**
- Consumes: `LineageLink`（Task 3, `front/lib/api/types.ts`）
- Produces:
  - `interface LineageNode { bucket: string; path: string }`
  - `type LineageNodeKind = 'bucket' | 'directory' | 'file'`
  - `nodeKind(path: string): LineageNodeKind`
  - `nodeKey(node: LineageNode): string`
  - `sameNode(a: LineageNode, b: LineageNode): boolean`
  - `edgesTouching(edges: LineageLink[], node: LineageNode): LineageLink[]`
  - `directParents(edges: LineageLink[], node: LineageNode): LineageLink[]`
  - `directChildren(edges: LineageLink[], node: LineageNode): LineageLink[]`
  - `ancestorGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][]`
  - `descendantGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][]`
  - `interface BucketEdge { parentBucket: string; childBucket: string }`
  - `collapseToBuckets(edges: LineageLink[]): BucketEdge[]`

- [ ] **Step 1: 失敗するテストを書く**

`front/lib/lineageGraph.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { LineageLink } from './api/types'
import {
  ancestorGenerations, collapseToBuckets, descendantGenerations,
  directChildren, directParents, edgesTouching, nodeKey, nodeKind, sameNode,
} from './lineageGraph'

function link(id: number, parent: [string, string], child: [string, string]): LineageLink {
  return {
    id,
    parentBucket: parent[0], parentPath: parent[1],
    childBucket: child[0], childPath: child[1],
    createdBy: 'test', createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('nodeKind', () => {
  it('空文字はバケット', () => expect(nodeKind('')).toBe('bucket'))
  it('末尾スラッシュはディレクトリ', () => expect(nodeKind('a/b/')).toBe('directory'))
  it('それ以外はファイル', () => expect(nodeKind('a/b.txt')).toBe('file'))
})

describe('nodeKey / sameNode', () => {
  it('bucket + path をユニークに識別する', () => {
    expect(nodeKey({ bucket: 'a', path: 'x/' })).not.toBe(nodeKey({ bucket: 'b', path: 'x/' }))
    expect(sameNode({ bucket: 'a', path: 'x/' }, { bucket: 'a', path: 'x/' })).toBe(true)
    expect(sameNode({ bucket: 'a', path: 'x/' }, { bucket: 'a', path: 'y/' })).toBe(false)
  })
})

describe('directParents / directChildren / edgesTouching', () => {
  const edges = [
    link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
    link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
    link(3, ['clean', 'v2/'], ['export', 'final/']),
  ]
  it('directParents: 子を指定すると親エッジだけ返す', () => {
    expect(directParents(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([1, 2])
  })
  it('directChildren: 親を指定すると子エッジだけ返す', () => {
    expect(directChildren(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([3])
  })
  it('edgesTouching: 親でも子でも当事者なら全部返す', () => {
    expect(edgesTouching(edges, { bucket: 'clean', path: 'v2/' }).map(e => e.id)).toEqual([1, 2, 3])
  })
})

describe('ancestorGenerations / descendantGenerations', () => {
  it('世代ごとに分けて返す', () => {
    const edges = [link(1, ['a', ''], ['b', '']), link(2, ['b', ''], ['c', ''])]
    expect(descendantGenerations(edges, { bucket: 'a', path: '' }))
      .toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'c', path: '' }]])
    expect(ancestorGenerations(edges, { bucket: 'c', path: '' }))
      .toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'a', path: '' }]])
  })

  it('循環があっても無限ループせず、同じノードを2度出さない', () => {
    const edges = [
      link(1, ['a', ''], ['b', '']),
      link(2, ['b', ''], ['c', '']),
      link(3, ['c', ''], ['a', '']), // 循環: a -> b -> c -> a
    ]
    const gens = descendantGenerations(edges, { bucket: 'a', path: '' })
    expect(gens).toEqual([[{ bucket: 'b', path: '' }], [{ bucket: 'c', path: '' }]])
  })

  it('複数の親・複数の子 (DAG のマージ/分岐) を1世代にまとめる', () => {
    const edges = [
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
    ]
    expect(ancestorGenerations(edges, { bucket: 'clean', path: 'v2/' })).toEqual([[
      { bucket: 'raw', path: '2024-01/' },
      { bucket: 'raw', path: '2024-02/' },
    ]])
  })

  it('リンクが無ければ空配列', () => {
    expect(ancestorGenerations([], { bucket: 'a', path: '' })).toEqual([])
    expect(descendantGenerations([], { bucket: 'a', path: '' })).toEqual([])
  })
})

describe('collapseToBuckets', () => {
  it('バケット間のペアに畳み、重複を除く', () => {
    const edges = [
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['raw', '2024-02/'], ['clean', 'v2/']),
      link(3, ['clean', 'v2/'], ['export', 'final/']),
    ]
    expect(collapseToBuckets(edges)).toEqual([
      { parentBucket: 'raw', childBucket: 'clean' },
      { parentBucket: 'clean', childBucket: 'export' },
    ])
  })

  it('同一バケット内で閉じたリンクは除外する', () => {
    expect(collapseToBuckets([link(1, ['raw', 'a/'], ['raw', 'b/'])])).toEqual([])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run lib/lineageGraph.test.ts`
Expected: FAIL — `Cannot find module './lineageGraph'`

- [ ] **Step 3: 実装する**

`front/lib/lineageGraph.ts`:

```ts
// データの家系図: ノード識別・グラフ走査・バケット集約の純関数群。
// LineageView / LineageGraphCanvas はここでレイアウトを組み立ててから描画する。

import type { LineageLink } from './api/types'

export interface LineageNode {
  bucket: string
  path: string
}

export type LineageNodeKind = 'bucket' | 'directory' | 'file'

// path === '' はバケット直下、末尾 '/' はディレクトリ、それ以外はファイル key
// (api/routes/storage-list.ts と同じ規約)。
export function nodeKind(path: string): LineageNodeKind {
  if (path === '') return 'bucket'
  return path.endsWith('/') ? 'directory' : 'file'
}

// bucket に '|' は S3 の DNS 互換バケット名では使えないので衝突しない。
export function nodeKey(node: LineageNode): string {
  return `${node.bucket}|${node.path}`
}

export function sameNode(a: LineageNode, b: LineageNode): boolean {
  return a.bucket === b.bucket && a.path === b.path
}

// クリックしたノードが当事者になっているエッジ (親としても子としても) を返す。
// ポップアップの「解除」リストに使う — 「全て」「バケット単位」モードには
// 単一の中心ノードという概念が無いため、常にこの形で一意に決める。
export function edgesTouching(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(
    e =>
      (e.parentBucket === node.bucket && e.parentPath === node.path) ||
      (e.childBucket === node.bucket && e.childPath === node.path),
  )
}

export function directParents(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(e => e.childBucket === node.bucket && e.childPath === node.path)
}

export function directChildren(edges: LineageLink[], node: LineageNode): LineageLink[] {
  return edges.filter(e => e.parentBucket === node.bucket && e.parentPath === node.path)
}

// 「現在地」モード: center から祖先方向 / 子孫方向へ辿れるだけ辿り、世代ごとに
// 配列を分ける (generations[0] = 直接の親/子、generations[1] = 祖父母/孫、…)。
// 循環 (A→B→A) があっても無限ループしないよう、訪問済みノードは全世代を通じて
// 一度しか出さない。
function generations(
  edges: LineageLink[],
  center: LineageNode,
  direction: 'up' | 'down',
): LineageNode[][] {
  const visited = new Set<string>([nodeKey(center)])
  const result: LineageNode[][] = []
  let frontier: LineageNode[] = [center]

  while (frontier.length > 0) {
    const next: LineageNode[] = []
    const seenThisGen = new Set<string>()
    for (const n of frontier) {
      const neighbours = direction === 'up' ? directParents(edges, n) : directChildren(edges, n)
      for (const e of neighbours) {
        const neighbour: LineageNode = direction === 'up'
          ? { bucket: e.parentBucket, path: e.parentPath }
          : { bucket: e.childBucket, path: e.childPath }
        const key = nodeKey(neighbour)
        if (visited.has(key) || seenThisGen.has(key)) continue
        seenThisGen.add(key)
        next.push(neighbour)
      }
    }
    if (next.length === 0) break
    next.forEach(n => visited.add(nodeKey(n)))
    result.push(next)
    frontier = next
  }
  return result
}

export function ancestorGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][] {
  return generations(edges, center, 'up')
}

export function descendantGenerations(edges: LineageLink[], center: LineageNode): LineageNode[][] {
  return generations(edges, center, 'down')
}

// 「バケット単位」モード: bucket 名だけを見てエッジを畳む。同一バケット内で
// 閉じたリンク (parentBucket === childBucket) は「バケット同士の関係」を
// 表さないので除外する。重複ペアはまとめる。
export interface BucketEdge {
  parentBucket: string
  childBucket: string
}

export function collapseToBuckets(edges: LineageLink[]): BucketEdge[] {
  const seen = new Set<string>()
  const result: BucketEdge[] = []
  for (const e of edges) {
    if (e.parentBucket === e.childBucket) continue
    const key = `${e.parentBucket}>${e.childBucket}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ parentBucket: e.parentBucket, childBucket: e.childBucket })
  }
  return result
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd front && npx vitest run lib/lineageGraph.test.ts`
Expected: PASS（13 tests）

- [ ] **Step 5: commit**

```bash
git add front/lib/lineageGraph.ts front/lib/lineageGraph.test.ts
git commit -m "feat: 家系図の祖先/子孫トラバーサルとバケット集約の純関数を追加する"
```

---

### Task 5: `LineageNodePopup` — ノードクリック時のポップアップ

ノード種別が `file` でない場合は既存 `ReadmeView` を、`file` の場合は既存 `PreviewText`/`PreviewImage` を縮小埋め込みする。README/プレビュー取得の失敗は、これら既存コンポーネントが元々内部で「存在しません」表示に丸めている（`ReadmeView` は `exists:false`、`PreviewText` は `status:'error'` を自前でメッセージ表示）ので、ポップアップ側で追加のエラーハンドリングは不要。ノードをグラフ上で事前にグレーアウトする（削除済みパスかどうかの一括判定）ことは、そのための一括存在チェック API が無いため v1 の対象外とする — ポップアップを開いたときに自然に「見つかりません」と分かれば十分、という判断（spec のエラー処理節の実装上の簡略化）。

**Files:**
- Create: `front/components/storage/lineage/LineageNodePopup.tsx`
- Create: `front/components/storage/lineage/LineageNodePopup.test.tsx`
- Modify: `front/App.css`

**Interfaces:**
- Consumes: `LineageNode`, `nodeKind`, `directParents`, `directChildren`（Task 4）、`LineageLink`（Task 3）、既存 `ReadmeView` / `PreviewText` / `PreviewImage` / `classify`（`front/lib/api/mime.ts`）。
- Produces: `LineageNodePopup(props: { connId: string; node: LineageNode; edges: LineageLink[]; onNavigate: (node: LineageNode) => void; onUnlink: (edgeId: number) => void; onClose: () => void }): JSX.Element`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/lineage/LineageNodePopup.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineageNodePopup } from './LineageNodePopup'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return { api: { ...mod.api, readme: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const edges: LineageLink[] = [
  {
    id: 1, parentBucket: 'raw', parentPath: '2024-01/',
    childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 2, parentBucket: 'clean', parentPath: 'v2/',
    childBucket: 'export', childPath: 'final/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
]

describe('LineageNodePopup', () => {
  it('directory ノードでは README 冒頭を表示する', async () => {
    vi.mocked(api.readme).mockResolvedValue({
      exists: true, body: '# clean v2', last_editor: 'aida', last_edited_at: '2026-01-01T00:00:00Z', size_bytes: 10,
    })
    render(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={vi.fn()} onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('clean v2')).toBeInTheDocument())
  })

  it('直接の親・子を一覧表示し、解除ボタンで onUnlink(edgeId) を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onUnlink = vi.fn()
    render(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={onUnlink} onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('raw/2024-01/')).toBeInTheDocument()
    expect(screen.getByText('export/final/')).toBeInTheDocument()

    const unlinkButtons = screen.getAllByRole('button', { name: '解除' })
    fireEvent.click(unlinkButtons[0])
    expect(onUnlink).toHaveBeenCalledWith(1)
  })

  it('「このパスへ移動」で onNavigate(node) を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onNavigate = vi.fn()
    render(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={onNavigate} onUnlink={vi.fn()} onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'このパスへ移動' }))
    expect(onNavigate).toHaveBeenCalledWith({ bucket: 'clean', path: 'v2/' })
  })

  it('✕ ボタンで onClose を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onClose = vi.fn()
    render(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={vi.fn()} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageNodePopup.test.tsx`
Expected: FAIL — `Cannot find module './LineageNodePopup'`

- [ ] **Step 3: 実装する**

`front/components/storage/lineage/LineageNodePopup.tsx`:

```tsx
// 家系図ビューでノードをクリックすると開く小さいポップアップ。
// bucket/directory は README 冒頭、file は既存のスニッフ済みプレビューを
// 縮小埋め込みする。加えて、このノード自身が当事者になっている直接の親子を
// 列挙し、行ごとに「解除」できるようにする — 「全て」「バケット単位」モードには
// 単一の中心ノードが無く、単純な「リンク解除」ボタン1つでは対象が一意に
// 決まらないため (front/lib/lineageGraph.ts の edgesTouching 相当を参照)。

import { classify } from '../../../lib/api/mime'
import type { LineageLink } from '../../../lib/api/types'
import { directChildren, directParents, nodeKind, type LineageNode } from '../../../lib/lineageGraph'
import { PreviewImage } from '../../PreviewImage'
import { PreviewText } from '../../PreviewText'
import { ReadmeView } from '../../ReadmeView'

interface Props {
  connId: string
  node: LineageNode
  edges: LineageLink[]
  onNavigate: (node: LineageNode) => void
  onUnlink: (edgeId: number) => void
  onClose: () => void
}

const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

function NeighbourRow(
  { label, edgeId, onUnlink }: { label: string; edgeId: number; onUnlink: (id: number) => void },
) {
  return (
    <li className="lineage-popup__neighbour">
      <span className="lineage-popup__neighbour-label">{label}</span>
      <button type="button" className="ghost" onClick={() => onUnlink(edgeId)}>
        解除
      </button>
    </li>
  )
}

export function LineageNodePopup({ connId, node, edges, onNavigate, onUnlink, onClose }: Props) {
  const kind = nodeKind(node.path)
  const parents = directParents(edges, node)
  const children = directChildren(edges, node)
  const label = node.path === '' ? node.bucket : `${node.bucket}/${node.path}`

  return (
    <div className="modal-backdrop modal-backdrop--lineage-node" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onClose}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div className="modal modal--lineage-node" role="dialog" aria-modal="true" aria-labelledby="lineage-node-title">
        <header className="lineage-popup__head">
          <p id="lineage-node-title" className="lineage-popup__title">
            <span aria-hidden>{KIND_ICON[kind]}</span> {label}
          </p>
          <button type="button" className="ghost" onClick={onClose} aria-label="閉じる">✕</button>
        </header>

        <div className="lineage-popup__body">
          {kind !== 'file' ? (
            <ReadmeView connId={connId} bucket={node.bucket} prefix={node.path} />
          ) : classify(node.path) === 'image' ? (
            <PreviewImage connId={connId} bucket={node.bucket} k={node.path} />
          ) : classify(node.path) === 'unknown' ? (
            <PreviewText connId={connId} bucket={node.bucket} k={node.path} />
          ) : (
            <p className="lineage-popup__unsupported">
              このファイル種別はここでは表示できません。「このパスへ移動」から開いてください。
            </p>
          )}
        </div>

        {(parents.length > 0 || children.length > 0) && (
          <div className="lineage-popup__neighbours">
            {parents.length > 0 && (
              <>
                <p className="label">↑ 親</p>
                <ul className="lineage-popup__neighbour-list">
                  {parents.map(e => (
                    <NeighbourRow key={e.id} edgeId={e.id} onUnlink={onUnlink} label={`${e.parentBucket}/${e.parentPath}`} />
                  ))}
                </ul>
              </>
            )}
            {children.length > 0 && (
              <>
                <p className="label">↓ 子</p>
                <ul className="lineage-popup__neighbour-list">
                  {children.map(e => (
                    <NeighbourRow key={e.id} edgeId={e.id} onUnlink={onUnlink} label={`${e.childBucket}/${e.childPath}`} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={() => onNavigate(node)}>このパスへ移動</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: CSS を追加する**

`front/App.css` の末尾に追加:

```css
/* ====================================================================
   家系図 — ノードポップアップ
   ==================================================================== */
.modal-backdrop--lineage-node { z-index: 55; }
.modal--lineage-node {
  width: min(480px, 100%);
  max-width: 480px;
  max-height: calc(100vh - var(--space-6));
  display: flex;
  flex-direction: column;
}
.lineage-popup__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
}
.lineage-popup__title {
  margin: 0;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 13px/1.4 var(--font-mono);
}
.lineage-popup__body {
  max-height: 40vh;
  overflow: auto;
}
.lineage-popup__unsupported { font: 400 12px/1.5 var(--font-sans); color: var(--ink-7); }
.lineage-popup__neighbours {
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--rule);
}
.lineage-popup__neighbour-list { margin: 0 0 var(--space-2); padding: 0; list-style: none; }
.lineage-popup__neighbour {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 4px 0;
  font: 400 12px/1.4 var(--font-mono);
}
.lineage-popup__neighbour-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageNodePopup.test.tsx`
Expected: PASS（4 tests）

- [ ] **Step 6: commit**

```bash
git add front/components/storage/lineage/LineageNodePopup.tsx \
        front/components/storage/lineage/LineageNodePopup.test.tsx front/App.css
git commit -m "feat: 家系図のノードポップアップを追加する"
```

---

### Task 6: `LineageGraphCanvas` — グラフ描画（プレゼンテーショナル）

「現在地」モードは世代ごとの列（祖先の遠い世代が左、中心、子孫の近い世代が右）、「全て」「バケット単位」モードは中心を持たないため親→子のエッジ一覧として描画する。

**Files:**
- Create: `front/components/storage/lineage/LineageGraphCanvas.tsx`
- Create: `front/components/storage/lineage/LineageGraphCanvas.test.tsx`
- Modify: `front/App.css`

**Interfaces:**
- Consumes: `LineageNode`, `nodeKind`, `nodeKey`（Task 4）
- Produces:
  - `interface CurrentLayout { scope: 'current'; center: LineageNode; ancestorGenerations: LineageNode[][]; descendantGenerations: LineageNode[][] }`
  - `interface EdgeListLayout { scope: 'all' | 'bucket'; edges: Array<{ id: string; parent: LineageNode; child: LineageNode }> }`
  - `type LineageLayout = CurrentLayout | EdgeListLayout`
  - `LineageGraphCanvas(props: { layout: LineageLayout; onNodeClick: (node: LineageNode) => void }): JSX.Element`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/lineage/LineageGraphCanvas.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LineageGraphCanvas, type LineageLayout } from './LineageGraphCanvas'

describe('LineageGraphCanvas', () => {
  it('current スコープ: 祖先/中心/子孫を列で描画し、クリックで onNodeClick を呼ぶ', () => {
    const onNodeClick = vi.fn()
    const layout: LineageLayout = {
      scope: 'current',
      center: { bucket: 'clean', path: 'v2/' },
      ancestorGenerations: [[{ bucket: 'raw', path: '2024-01/' }]],
      descendantGenerations: [[{ bucket: 'export', path: 'final/' }]],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={onNodeClick} />)

    fireEvent.click(screen.getByRole('button', { name: /raw\/2024-01\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'raw', path: '2024-01/' })

    fireEvent.click(screen.getByRole('button', { name: /clean\/v2\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'clean', path: 'v2/' })

    fireEvent.click(screen.getByRole('button', { name: /export\/final\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'export', path: 'final/' })
  })

  it('current スコープ: リンクが無ければ空状態メッセージを出す', () => {
    const layout: LineageLayout = {
      scope: 'current',
      center: { bucket: 'clean', path: 'v2/' },
      ancestorGenerations: [],
      descendantGenerations: [],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={vi.fn()} />)
    expect(screen.getByText('登録されたリンクがありません。')).toBeInTheDocument()
  })

  it('all/bucket スコープ: 親→子のエッジ一覧を描画する', () => {
    const onNodeClick = vi.fn()
    const layout: LineageLayout = {
      scope: 'bucket',
      edges: [{ id: 'e1', parent: { bucket: 'raw', path: '' }, child: { bucket: 'clean', path: '' } }],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={onNodeClick} />)
    fireEvent.click(screen.getByRole('button', { name: /^📦 raw/ }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'raw', path: '' })
  })

  it('all/bucket スコープ: エッジが無ければ空状態メッセージを出す', () => {
    render(<LineageGraphCanvas layout={{ scope: 'all', edges: [] }} onNodeClick={vi.fn()} />)
    expect(screen.getByText('登録されたリンクがありません。')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageGraphCanvas.test.tsx`
Expected: FAIL — `Cannot find module './LineageGraphCanvas'`

- [ ] **Step 3: 実装する**

`front/components/storage/lineage/LineageGraphCanvas.tsx`:

```tsx
// 家系図のグラフ描画 (プレゼンテーショナル)。データの取得・レイアウト計算は
// LineageView が front/lib/lineageGraph.ts を使って行い、ここは受け取った
// レイアウトを並べるだけ。
//
// 「現在地」モードは中心ノードを持つので世代ごとの列で描く。
// 「全て」「バケット単位」モードは単一の中心が無いので、親→子のエッジを
// フラットに列挙する (登録数が増えても実装が複雑にならないシンプルな形)。

import { nodeKey, nodeKind, type LineageNode } from '../../../lib/lineageGraph'

export interface CurrentLayout {
  scope: 'current'
  center: LineageNode
  ancestorGenerations: LineageNode[][]
  descendantGenerations: LineageNode[][]
}

export interface EdgeListLayout {
  scope: 'all' | 'bucket'
  edges: Array<{ id: string; parent: LineageNode; child: LineageNode }>
}

export type LineageLayout = CurrentLayout | EdgeListLayout

interface Props {
  layout: LineageLayout
  onNodeClick: (node: LineageNode) => void
}

const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

function NodeBox({ node, onClick, emphasize }: { node: LineageNode; onClick: () => void; emphasize?: boolean }) {
  const kind = nodeKind(node.path)
  const label = node.path === '' ? node.bucket : `${node.bucket}/${node.path}`
  return (
    <button
      type="button"
      className="lineage-node"
      data-emphasize={emphasize || undefined}
      onClick={onClick}
      title={label}
    >
      {KIND_ICON[kind]} {label}
    </button>
  )
}

const EMPTY_MESSAGE = '登録されたリンクがありません。'

export function LineageGraphCanvas({ layout, onNodeClick }: Props) {
  if (layout.scope === 'current') {
    const ancestorCols = [...layout.ancestorGenerations].reverse()
    const isEmpty = ancestorCols.length === 0 && layout.descendantGenerations.length === 0
    return (
      <div className="lineage-canvas">
        {isEmpty ? (
          <p className="lineage-canvas__empty">{EMPTY_MESSAGE}</p>
        ) : (
          <>
            {ancestorCols.map((col, i) => (
              <div className="lineage-column" key={`a${i}`}>
                {col.map(n => (
                  <NodeBox key={nodeKey(n)} node={n} onClick={() => onNodeClick(n)} />
                ))}
              </div>
            ))}
            <div className="lineage-column lineage-column--center">
              <NodeBox node={layout.center} onClick={() => onNodeClick(layout.center)} emphasize />
            </div>
            {layout.descendantGenerations.map((col, i) => (
              <div className="lineage-column" key={`d${i}`}>
                {col.map(n => (
                  <NodeBox key={nodeKey(n)} node={n} onClick={() => onNodeClick(n)} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    )
  }

  if (layout.edges.length === 0) {
    return <p className="lineage-canvas__empty">{EMPTY_MESSAGE}</p>
  }
  return (
    <ul className="lineage-edge-list">
      {layout.edges.map(e => (
        <li key={e.id} className="lineage-edge-row">
          <NodeBox node={e.parent} onClick={() => onNodeClick(e.parent)} />
          <span aria-hidden className="lineage-edge-arrow">→</span>
          <NodeBox node={e.child} onClick={() => onNodeClick(e.child)} />
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: CSS を追加する**

`front/App.css` の末尾に追加:

```css
/* ====================================================================
   家系図 — グラフ描画
   ==================================================================== */
.lineage-canvas {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  overflow-x: auto;
  padding: var(--space-5);
}
.lineage-canvas__empty { padding: var(--space-4); font: 400 13px/1.5 var(--font-sans); color: var(--ink-7); }
.lineage-column {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 0 0 auto;
}
.lineage-column--center { position: relative; }
.lineage-node {
  background: var(--paper);
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-1);
  padding: 8px 12px;
  font: 400 12px/1.3 var(--font-mono);
  color: var(--ink-11);
  cursor: pointer;
  white-space: nowrap;
  text-align: left;
}
.lineage-node:hover { background: var(--ink-1); }
.lineage-node[data-emphasize] {
  background: var(--ink-12);
  color: var(--paper);
  border-color: var(--ink-12);
  font-weight: 600;
}
.lineage-edge-list { margin: 0; padding: var(--space-4); list-style: none; display: flex; flex-direction: column; gap: var(--space-2); }
.lineage-edge-row { display: flex; align-items: center; gap: var(--space-2); }
.lineage-edge-arrow { color: var(--ink-5); }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageGraphCanvas.test.tsx`
Expected: PASS（4 tests）

- [ ] **Step 6: commit**

```bash
git add front/components/storage/lineage/LineageGraphCanvas.tsx \
        front/components/storage/lineage/LineageGraphCanvas.test.tsx front/App.css
git commit -m "feat: 家系図のグラフ描画コンポーネントを追加する"
```

---

### Task 7: `LineageLinkPicker` — リンク追加の相手ノード選択モーダル

`InsertableFileList`（README エディタの左ペイン）と同じ「非 recursive リスト + 内部 state での潜り」の作りだが、(a) バケットをまたいで選べる、(b) 「今見ている階層そのもの（バケット直下 / ディレクトリ）」を選べる、(c) 除外対象ノードを選べなくする、という3点が異なるため専用に新規作成する。

**Files:**
- Create: `front/components/storage/lineage/LineageLinkPicker.tsx`
- Create: `front/components/storage/lineage/LineageLinkPicker.test.tsx`
- Modify: `front/App.css`

**Interfaces:**
- Consumes: `api.buckets`, `api.list`（既存 `front/lib/api/client.ts`）、`sameNode`, `LineageNode`（Task 4）
- Produces: `LineageLinkPicker(props: { connId: string; initialBucket: string; initialPrefix: string; exclude: LineageNode; onSelect: (node: LineageNode) => void; onCancel: () => void }): JSX.Element`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/lineage/LineageLinkPicker.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineageLinkPicker } from './LineageLinkPicker'
import { api } from '../../../lib/api/client'

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return { api: { ...mod.api, buckets: vi.fn(), list: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

function setup() {
  vi.mocked(api.buckets).mockResolvedValue({
    buckets: [{ name: 'raw', creationDate: null }, { name: 'clean', creationDate: null }],
  })
  vi.mocked(api.list).mockResolvedValue({
    directories: ['2024-01/'], files: [{ key: 'meta.json', size: 10, lastModified: null }],
    nextContinuation: null, nextStartAfter: null,
  })
}

describe('LineageLinkPicker', () => {
  it('現在のディレクトリを選択できる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/2024-01\//)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'このバケット直下を選択' }))
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: '' })
  })

  it('ディレクトリ行の「選択」でそのディレクトリを選べる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/2024-01\//)).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: '選択' })[0])
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: '2024-01/' })
  })

  it('ファイル行の「選択」でそのファイルを選べる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/meta\.json/)).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: '選択' })[1])
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: 'meta.json' })
  })

  it('除外ノード (自分自身) は選択できない', async () => {
    vi.mocked(api.buckets).mockResolvedValue({ buckets: [{ name: 'raw', creationDate: null }] })
    vi.mocked(api.list).mockResolvedValue({
      directories: [], files: [], nextContinuation: null, nextStartAfter: null,
    })
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'raw', path: '' }}
        onSelect={vi.fn()} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'このバケット直下を選択' })).toBeDisabled()
  })

  it('バケットを切り替えると prefix がリセットされ、そのバケットを一覧する', async () => {
    setup()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="deep/" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={vi.fn()} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('c1', 'raw', 'deep/', {}, { recursive: false }))
    fireEvent.change(screen.getByLabelText('バケット'), { target: { value: 'clean' } })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('c1', 'clean', '', {}, { recursive: false }))
  })

  it('キャンセルボタンで onCancel を呼ぶ', async () => {
    setup()
    const onCancel = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={vi.fn()} onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageLinkPicker.test.tsx`
Expected: FAIL — `Cannot find module './LineageLinkPicker'`

- [ ] **Step 3: 実装する**

`front/components/storage/lineage/LineageLinkPicker.tsx`:

```tsx
// 家系図の「リンクを追加」フローで、相手ノード (bucket / directory / file) を
// 選ぶモーダルピッカー。InsertableFileList (README エディタの左ペイン) と
// 同じ「非 recursive リスト + 内部 state での潜り」の作りだが、バケットを
// またいで選べる点と、「今見ている階層そのもの」を選べる点が異なる。

import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../../../lib/api/client'
import { StorageList } from '../../../lib/api/types'
import { sameNode, type LineageNode } from '../../../lib/lineageGraph'

interface Props {
  connId: string
  initialBucket: string
  initialPrefix: string
  exclude: LineageNode
  onSelect: (node: LineageNode) => void
  onCancel: () => void
}

type ListResp = z.infer<typeof StorageList>

export function LineageLinkPicker(
  { connId, initialBucket, initialPrefix, exclude, onSelect, onCancel }: Props,
) {
  const [buckets, setBuckets] = useState<string[] | null>(null)
  const [bucket, setBucket] = useState(initialBucket)
  const [prefix, setPrefix] = useState(initialPrefix)
  const [data, setData] = useState<ListResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.buckets(connId).then(r => setBuckets(r.buckets.map(b => b.name))).catch(() => setBuckets([]))
  }, [connId])

  useEffect(() => {
    setData(null)
    setError(null)
    let cancelled = false
    api.list(connId, bucket, prefix, {}, { recursive: false })
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  const crumbs = prefix.split('/').filter(Boolean)
  const goTo = (idx: number) => {
    if (idx < 0) { setPrefix(''); return }
    setPrefix(crumbs.slice(0, idx + 1).join('/') + '/')
  }
  const changeBucket = (next: string) => { setBucket(next); setPrefix('') }

  const currentIsExcluded = sameNode({ bucket, path: prefix }, exclude)

  return (
    <div className="modal-backdrop modal-backdrop--lineage-picker" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onCancel}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div className="modal modal--lineage-picker" role="dialog" aria-modal="true" aria-labelledby="lineage-picker-title">
        <header className="lineage-picker__head">
          <h3 id="lineage-picker-title" className="lineage-picker__title">ノードを選択</h3>
          <label className="lineage-picker__bucket-select">
            <span className="label">バケット</span>
            <select value={bucket} onChange={e => changeBucket(e.target.value)} disabled={!buckets}>
              {(buckets ?? [bucket]).map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        </header>

        <div className="filelist">
          <nav className="filelist__crumbs" aria-label="現在のディレクトリ">
            <button type="button" className="filelist__crumb" onClick={() => goTo(-1)} disabled={crumbs.length === 0}>
              {bucket}
            </button>
            {crumbs.map((seg, i) => (
              <span key={i} className="filelist__crumb-wrap">
                <span aria-hidden className="filelist__crumb-sep">/</span>
                <button type="button" className="filelist__crumb" onClick={() => goTo(i)} disabled={i === crumbs.length - 1}>
                  {seg}
                </button>
              </span>
            ))}
          </nav>

          <button
            type="button"
            className="filelist__select-current"
            disabled={currentIsExcluded}
            onClick={() => onSelect({ bucket, path: prefix })}
          >
            {prefix === '' ? 'このバケット直下を選択' : 'このディレクトリを選択'}
          </button>

          {error ? (
            <p className="filelist__error" role="alert">{error}</p>
          ) : !data ? (
            <p className="filelist__loading">読み込み中…</p>
          ) : data.directories.length === 0 && data.files.length === 0 ? (
            <p className="filelist__empty">エントリなし</p>
          ) : (
            <ul className="filelist__rows">
              {data.directories.map(d => {
                const base = d.slice(prefix.length).replace(/\/$/, '')
                const excluded = sameNode({ bucket, path: d }, exclude)
                return (
                  <li key={d} className="filelist__row filelist__row--dir">
                    <span className="filelist__label">
                      <span aria-hidden className="filelist__icon">📁</span>
                      {base}/
                    </span>
                    <button type="button" className="filelist__select" disabled={excluded} onClick={() => onSelect({ bucket, path: d })}>
                      選択
                    </button>
                    <button type="button" className="filelist__open" onClick={() => setPrefix(d)}>
                      ↓ 開く
                    </button>
                  </li>
                )
              })}
              {data.files.map(f => {
                const base = f.key.slice(prefix.length)
                const excluded = sameNode({ bucket, path: f.key }, exclude)
                return (
                  <li key={f.key} className="filelist__row filelist__row--file">
                    <span className="filelist__label">
                      <span aria-hidden className="filelist__icon">📄</span>
                      {base}
                    </span>
                    <button type="button" className="filelist__select" disabled={excluded} onClick={() => onSelect({ bucket, path: f.key })}>
                      選択
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>キャンセル</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: CSS を追加する**

`front/App.css` の末尾に追加。まず既存の `.filelist__open` / `.filelist__open:hover` ルール（`.filelist__row` ブロック内、およそ 1165〜1176 行目）を編集し、`.filelist__select` にも同じスタイルを当てる:

```css
.filelist__open,
.filelist__select {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid var(--rule);
  padding: 3px 8px;
  font: 400 10.5px/1.3 var(--font-sans);
  color: var(--ink-9);
  cursor: pointer;
  border-radius: var(--radius-1);
  letter-spacing: 0.08em;
}
.filelist__open:hover,
.filelist__select:hover:not(:disabled) { background: var(--paper); border-color: var(--color-rule-strong); color: var(--ink-12); }
.filelist__select:disabled { opacity: 0.4; cursor: default; }
```

その上で、ファイルの末尾に以下を追加（`.filelist__name` と同じ見た目だがクリック不可のラベル、ピッカー専用の見出し・選択ボタン）:

```css
/* ====================================================================
   家系図 — リンク追加ピッカー
   ==================================================================== */
.modal-backdrop--lineage-picker { z-index: 55; }
.modal--lineage-picker {
  width: min(640px, 100%);
  max-width: 640px;
  max-height: calc(100vh - var(--space-6));
  display: flex;
  flex-direction: column;
}
.lineage-picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--rule);
}
.lineage-picker__title { margin: 0; font: 600 13px/1.3 var(--font-sans); }
.lineage-picker__bucket-select { display: flex; align-items: center; gap: var(--space-2); font: 400 12px/1.3 var(--font-sans); }

.filelist__label {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 8px 6px;
  font: 400 13px/1.4 var(--font-mono);
  color: var(--ink-11);
}
.filelist__select-current {
  margin: var(--space-2) var(--space-3);
  align-self: flex-start;
  background: var(--ink-1);
  border: 1px solid var(--color-rule-strong);
  border-radius: var(--radius-1);
  padding: 6px 12px;
  font: 500 12px/1.3 var(--font-sans);
  color: var(--ink-12);
  cursor: pointer;
}
.filelist__select-current:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageLinkPicker.test.tsx`
Expected: PASS（6 tests）

- [ ] **Step 6: commit**

```bash
git add front/components/storage/lineage/LineageLinkPicker.tsx \
        front/components/storage/lineage/LineageLinkPicker.test.tsx front/App.css
git commit -m "feat: 家系図のリンク追加ピッカーを追加する"
```

---

### Task 8: `LineageView` — オーケストレーター

エッジの取得・表示スコープの状態・ノードクリック時のポップアップ・「リンクを追加」フロー（方向選択 → ピッカー → 編集者名 → POST）を束ねる。編集者名は README/Notes と同じ `localStorage['dashboard.lastEditor']`（`front/components/EditorShell.tsx` 参照）を再利用し、他の編集画面と名前が揃うようにする。

**Files:**
- Create: `front/components/storage/lineage/LineageView.tsx`
- Create: `front/components/storage/lineage/LineageView.test.tsx`
- Modify: `front/App.css`

**Interfaces:**
- Consumes: `api.lineageLinks/addLineageLink/removeLineageLink`（Task 3）、`ancestorGenerations/descendantGenerations/collapseToBuckets/LineageNode`（Task 4）、`LineageGraphCanvas`/`LineageLayout`（Task 6）、`LineageNodePopup`（Task 5）、`LineageLinkPicker`（Task 7）、`encPath`（`front/lib/route.ts`）
- Produces: `LineageView(props: { connId: string; bucket: string; prefix: string }): JSX.Element`（`react-router-dom` の Router コンテキスト内で使うこと — `useNavigate` を使う）

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/lineage/LineageView.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LineageView } from './LineageView'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      lineageLinks: vi.fn(),
      addLineageLink: vi.fn(),
      removeLineageLink: vi.fn(),
      readme: vi.fn(),
      buckets: vi.fn(),
      list: vi.fn(),
    },
  }
})

const edges: LineageLink[] = [
  {
    id: 1, parentBucket: 'raw', parentPath: '2024-01/',
    childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
]

beforeEach(() => {
  localStorage.clear()
  vi.mocked(api.readme).mockResolvedValue({ exists: false })
})
afterEach(() => vi.clearAllMocks())

function renderView() {
  return render(
    <MemoryRouter>
      <LineageView connId="c1" bucket="clean" prefix="v2/" />
    </MemoryRouter>,
  )
}

describe('LineageView', () => {
  it('マウント時にエッジを取得し、現在地スコープで中心ノードを描画する', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledWith('c1'))
    expect(await screen.findByRole('button', { name: /clean\/v2\// })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '現在地' })).toHaveAttribute('aria-selected', 'true')
  })

  it('スコープタブを切り替えるとエッジ一覧表示になる', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()
    await screen.findByRole('button', { name: /clean\/v2\// })

    fireEvent.click(screen.getByRole('tab', { name: '全て' }))
    expect(await screen.findByRole('button', { name: /raw\/2024-01\// })).toBeInTheDocument()
  })

  it('ノードをクリックするとポップアップが開き、解除で removeLineageLink が呼ばれ再取得する', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    vi.mocked(api.removeLineageLink).mockResolvedValue(undefined)
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: /clean\/v2\// }))

    const unlinkBtn = await screen.findByRole('button', { name: '解除' })
    fireEvent.click(unlinkBtn)
    await waitFor(() => expect(api.removeLineageLink).toHaveBeenCalledWith('c1', 1))
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledTimes(2))
  })

  it('親を追加フロー: ピッカーで選択 → 編集者名入力 → addLineageLink が正しい引数で呼ばれる', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue([])
    vi.mocked(api.buckets).mockResolvedValue({
      buckets: [{ name: 'raw', creationDate: null }, { name: 'clean', creationDate: null }],
    })
    vi.mocked(api.list).mockResolvedValue({
      directories: [], files: [{ key: 'source.wav', size: 1, lastModified: null }],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.mocked(api.addLineageLink).mockResolvedValue(99)

    renderView()
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalled())

    // ピッカーは LineageView 側の bucket/prefix ('clean' / 'v2/') を初期値に開く。
    // api.list は引数によらず同じ file を返すモックなので、バケットを切り替えずに選択できる。
    fireEvent.click(screen.getByRole('button', { name: '＋ 親を追加' }))
    fireEvent.click(await screen.findByRole('button', { name: '選択' }))

    const nameInput = await screen.findByLabelText('編集者名')
    fireEvent.change(nameInput, { target: { value: 'aida' } })
    fireEvent.click(screen.getByRole('button', { name: 'リンクを追加' }))

    await waitFor(() => expect(api.addLineageLink).toHaveBeenCalledWith(
      'c1',
      { bucket: 'raw', path: 'source.wav' },
      { bucket: 'clean', path: 'v2/' },
      'aida',
    ))
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('aida')
  })
})
```

`aria-selected` を持つ `role="tab"` は StorageBucket 側（Task 9）にも出てくるが、`LineageView` 単体テストではこのコンポーネントしかマウントしないため名前の衝突はない。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageView.test.tsx`
Expected: FAIL — `Cannot find module './LineageView'`

- [ ] **Step 3: 実装する**

`front/components/storage/lineage/LineageView.tsx`:

```tsx
// 家系図ビュー本体。StorageBucket の「一覧 / 家系図」タブから開く。
// 1) エッジを1度だけ全件取得する (表示スコープの絞り込みはここでクライアント側に行う — 詳細は spec 参照)
// 2) スコープ切替 (現在地 / 全て / バケット単位) の状態を持つ
// 3) ノードクリックでポップアップ、「＋ 親/子を追加」でピッカー付きの追加フローを開く

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'
import { encPath } from '../../../lib/route'
import {
  ancestorGenerations, collapseToBuckets, descendantGenerations, type LineageNode,
} from '../../../lib/lineageGraph'
import { LineageGraphCanvas, type LineageLayout } from './LineageGraphCanvas'
import { LineageNodePopup } from './LineageNodePopup'
import { LineageLinkPicker } from './LineageLinkPicker'

interface Props {
  connId: string
  bucket: string
  prefix: string
}

type Scope = 'current' | 'all' | 'bucket'
type Direction = 'parent' | 'child'
interface PendingAdd { direction: Direction; node: LineageNode }

const LAST_EDITOR_KEY = 'dashboard.lastEditor'
const SCOPE_LABEL: Record<Scope, string> = { current: '現在地', all: '全て', bucket: 'バケット単位' }

export function LineageView({ connId, bucket, prefix }: Props) {
  const navigate = useNavigate()
  const center: LineageNode = useMemo(() => ({ bucket, path: prefix }), [bucket, prefix])

  const [edges, setEdges] = useState<LineageLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('current')
  const [popupNode, setPopupNode] = useState<LineageNode | null>(null)
  const [addDirection, setAddDirection] = useState<Direction | null>(null)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [editor, setEditor] = useState(() => localStorage.getItem(LAST_EDITOR_KEY) ?? '')
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(() => {
    setError(null)
    api.lineageLinks(connId).then(setEdges).catch(e => setError((e as Error).message))
  }, [connId])

  useEffect(() => { refresh() }, [refresh])

  const goTo = (node: LineageNode) => {
    navigate(`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(node.bucket)}/${encPath(node.path)}`)
  }

  const handleUnlink = async (edgeId: number) => {
    try {
      await api.removeLineageLink(connId, edgeId)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const confirmAdd = async () => {
    if (!pendingAdd) return
    setSaving(true)
    setError(null)
    try {
      const parent = pendingAdd.direction === 'parent' ? pendingAdd.node : center
      const child = pendingAdd.direction === 'parent' ? center : pendingAdd.node
      await api.addLineageLink(connId, parent, child, editor)
      localStorage.setItem(LAST_EDITOR_KEY, editor)
      setPendingAdd(null)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const layout: LineageLayout | null = useMemo(() => {
    if (!edges) return null
    if (scope === 'current') {
      return {
        scope: 'current',
        center,
        ancestorGenerations: ancestorGenerations(edges, center),
        descendantGenerations: descendantGenerations(edges, center),
      }
    }
    if (scope === 'bucket') {
      return {
        scope: 'bucket',
        edges: collapseToBuckets(edges).map((e, i) => ({
          id: `${e.parentBucket}>${e.childBucket}:${i}`,
          parent: { bucket: e.parentBucket, path: '' },
          child: { bucket: e.childBucket, path: '' },
        })),
      }
    }
    return {
      scope: 'all',
      edges: edges.map(e => ({
        id: String(e.id),
        parent: { bucket: e.parentBucket, path: e.parentPath },
        child: { bucket: e.childBucket, path: e.childPath },
      })),
    }
  }, [edges, scope, center])

  return (
    <section className="lineage-view">
      <div className="lineage-view__toolbar">
        <div className="lineage-view__scopes" role="tablist" aria-label="表示スコープ">
          {(Object.keys(SCOPE_LABEL) as Scope[]).map(s => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className="lineage-view__scope-btn"
              data-active={scope === s || undefined}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="lineage-view__add-actions">
          <button type="button" onClick={() => setAddDirection('parent')}>＋ 親を追加</button>
          <button type="button" onClick={() => setAddDirection('child')}>＋ 子を追加</button>
        </div>
      </div>

      {error && <p className="filelist__error" role="alert">{error}</p>}
      {!layout ? (
        <p className="lineage-canvas__empty">読み込み中…</p>
      ) : (
        <LineageGraphCanvas layout={layout} onNodeClick={setPopupNode} />
      )}

      {popupNode && edges && (
        <LineageNodePopup
          connId={connId}
          node={popupNode}
          edges={edges}
          onNavigate={goTo}
          onUnlink={id => { void handleUnlink(id) }}
          onClose={() => setPopupNode(null)}
        />
      )}

      {addDirection && (
        <LineageLinkPicker
          connId={connId}
          initialBucket={bucket}
          initialPrefix={prefix}
          exclude={center}
          onCancel={() => setAddDirection(null)}
          onSelect={node => { setPendingAdd({ direction: addDirection, node }); setAddDirection(null) }}
        />
      )}

      {pendingAdd && (
        <div className="modal-backdrop" role="presentation">
          <button
            type="button"
            className="modal-backdrop__close-overlay"
            onClick={() => setPendingAdd(null)}
            aria-label="モーダルを閉じる"
            tabIndex={-1}
          />
          <div className="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="lineage-add-title">
            <h3 id="lineage-add-title" className="lineage-add__title">
              {pendingAdd.direction === 'parent' ? 'この親を追加' : 'この子を追加'}
            </h3>
            <p className="lineage-add__target">
              {pendingAdd.node.bucket}/{pendingAdd.node.path}
            </p>
            <label className="lineage-add__editor">
              <span className="label">編集者名</span>
              <input
                value={editor}
                onChange={e => setEditor(e.target.value)}
                placeholder="e.g. tanaka"
                autoComplete="nickname"
                aria-label="編集者名"
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingAdd(null)} disabled={saving}>キャンセル</button>
              <button type="button" onClick={() => void confirmAdd()} disabled={saving || !editor}>
                {saving ? '保存中…' : 'リンクを追加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 4: CSS を追加する**

`front/App.css` の末尾に追加:

```css
/* ====================================================================
   家系図 — ビュー全体 (ツールバー・追加モーダル)
   ==================================================================== */
.lineage-view { display: flex; flex-direction: column; gap: var(--space-3); }
.lineage-view__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.lineage-view__scopes { display: flex; gap: 4px; }
.lineage-view__scope-btn {
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: var(--radius-1);
  padding: 5px 12px;
  font: 400 12px/1.3 var(--font-sans);
  color: var(--ink-9);
  cursor: pointer;
}
.lineage-view__scope-btn[data-active] { background: var(--ink-12); color: var(--paper); border-color: var(--ink-12); }
.lineage-view__add-actions { display: flex; gap: var(--space-2); }
.lineage-add__title { margin: 0 0 var(--space-2); font: 600 13px/1.3 var(--font-sans); }
.lineage-add__target { margin: 0 0 var(--space-3); font: 400 12px/1.4 var(--font-mono); color: var(--ink-9); }
.lineage-add__editor { display: flex; flex-direction: column; gap: 4px; font: 400 12px/1.3 var(--font-sans); }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run components/storage/lineage/LineageView.test.tsx`
Expected: PASS（4 tests）

- [ ] **Step 6: フロント全体のテストを流す**

Run: `cd front && npm test`
Expected: PASS（全ファイル、既存分含む）

- [ ] **Step 7: commit**

```bash
git add front/components/storage/lineage/LineageView.tsx \
        front/components/storage/lineage/LineageView.test.tsx front/App.css
git commit -m "feat: 家系図ビューのオーケストレーターを追加する"
```

---

### Task 9: `StorageBucket` に「一覧 / 家系図」タブを追加する

**Files:**
- Modify: `front/pages/StorageBucket.tsx`
- Create: `front/pages/StorageBucket.test.tsx`
- Modify: `front/App.css`

**Interfaces:**
- Consumes: `LineageView`（Task 8）
- Produces: `StorageBucket` が `?view=lineage` を解釈し、`role="tab"` の「一覧」「🔗 家系図」ボタンで切り替える。

- [ ] **Step 1: 失敗するテストを書く**

`front/pages/StorageBucket.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StorageBucket from './StorageBucket'
import { api } from '../lib/api/client'
import { ConnectionContext } from '../lib/connectionContext'
import type { Connection } from '../lib/api/types'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      list: vi.fn(),
      readme: vi.fn(),
      listConnections: vi.fn(),
      lineageLinks: vi.fn(),
    },
  }
})

afterEach(() => vi.clearAllMocks())

const connection: Connection = {
  id: 'c1', name: 'c1', endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: true, listObjectsVersion: 'v2',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
}

function renderPage() {
  vi.mocked(api.list).mockResolvedValue({ directories: [], files: [], nextContinuation: null, nextStartAfter: null })
  vi.mocked(api.readme).mockResolvedValue({ exists: false })
  vi.mocked(api.listConnections).mockResolvedValue([connection])
  vi.mocked(api.lineageLinks).mockResolvedValue([])
  return render(
    <MemoryRouter initialEntries={['/storage/c1/bucket-a/']}>
      <ConnectionContext.Provider value={connection}>
        <Routes>
          <Route path="/storage/:connId/:bucket/*" element={<StorageBucket connId="c1" />} />
        </Routes>
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('StorageBucket のタブ切り替え', () => {
  it('既定では一覧タブが選択され、家系図は取得しない', async () => {
    renderPage()
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'true')
    expect(api.lineageLinks).not.toHaveBeenCalled()
  })

  it('「家系図」タブを押すと LineageView が描画され、一覧タブに戻せる', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(api.list).toHaveBeenCalled())

    await user.click(screen.getByRole('tab', { name: /家系図/ }))
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledWith('c1'))
    expect(screen.getByRole('tab', { name: /家系図/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'false')

    await user.click(screen.getByRole('tab', { name: '一覧' }))
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'true')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd front && npx vitest run pages/StorageBucket.test.tsx`
Expected: FAIL（`role="tab"` の要素が存在しない）

- [ ] **Step 3: `StorageBucket.tsx` を変更する**

import 群に追加:

```ts
import { LineageView } from '../components/storage/lineage/LineageView'
```

`selected`/`setSelected` の宣言の近く（`searchParams`/`setSearchParams` を使っている箇所）に追加:

```ts
  const view = searchParams.get('view') === 'lineage' ? 'lineage' : 'list'
  const setView = useCallback((v: 'lineage' | 'list') => {
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (v === 'list') next.delete('view')
        else next.set('view', v)
        return next
      },
      { replace: false },
    )
  }, [setSearchParams])
```

`useCallback` は既に import 済み（`setSelected` 等で使用中）なのでそのまま使える。

`return` 内、`<div className="flex items-center justify-between gap-3">...</div>` の直後、`ReadmeView` の手前に挿入し、`ReadmeView` 以下を `view` で分岐する:

```tsx
      <nav className="storage-bucket__tabs" role="tablist" aria-label="表示切り替え">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'list'}
          className="storage-bucket__tab"
          onClick={() => setView('list')}
        >
          一覧
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'lineage'}
          className="storage-bucket__tab"
          onClick={() => setView('lineage')}
        >
          🔗 家系図
        </button>
      </nav>
      {view === 'lineage' ? (
        <LineageView connId={connId} bucket={bucket} prefix={prefix} />
      ) : (
        <>
          {/* README はリスト幅に依存させない (常に full width) */}
          <ReadmeView connId={connId} bucket={bucket} prefix={prefix} />
          {/* リスト + preview drawer を横並び。drawer 幅は drawer 左端のハンドルで
              リサイズでき、広げるとリストを圧縮せず上に重なる (useDrawerResize)。
              ハンドルは drawer 内に置き、その高さに収める。README には影響しない。 */}
          <div className="storage-list" ref={containerRef}>
            <StorageBrowser connId={connId} bucket={bucket} prefix={prefix} onSelectFile={setSelected} />
            <PreviewDrawer
              connId={connId}
              bucket={bucket}
              k={selected}
              entry={selectedEntry}
              onEntryChange={setSelectedEntry}
              onClose={() => setSelected(null)}
              onResizeStart={onResizeStart}
              onResizeKeyDown={onResizeKeyDown}
              onResetWidth={resetWidth}
              widthCustomized={widthCustomized}
            />
          </div>
        </>
      )}
```

既存の `<ReadmeView .../>` と `<div className="storage-list" ...>...</div>` の元の並び（分岐前にあったもの）は上のブロックに置き換える形で削除する。

- [ ] **Step 4: CSS を追加する**

`front/App.css` の末尾に追加:

```css
/* ====================================================================
   StorageBucket — 一覧 / 家系図 タブ
   ==================================================================== */
.storage-bucket__tabs { display: flex; gap: var(--space-2); margin: var(--space-2) 0; }
.storage-bucket__tab {
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 6px 2px;
  font: 500 12.5px/1.3 var(--font-sans);
  color: var(--ink-7);
  cursor: pointer;
}
.storage-bucket__tab[aria-selected="true"] { color: var(--ink-12); border-bottom-color: var(--ink-12); }
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd front && npx vitest run pages/StorageBucket.test.tsx`
Expected: PASS（2 tests）

- [ ] **Step 6: フロント全体のテスト + lint を流す**

Run: `cd front && npm test && npm run lint`
Expected: PASS（全ファイル、lint エラーなし）

- [ ] **Step 7: 手動確認**

```bash
docker compose -f compose.dev.yaml up -d   # DB
cd api && npm run dev &                     # :8787 相当 (env の PORT 参照)
cd front && npm run dev                     # vite dev server
```

ブラウザで `/storage/<connId>/<bucket>/` を開き、以下を確認する:
- 「一覧 / 🔗 家系図」タブが表示され、切り替わる。
- 家系図タブで「＋ 親を追加」→ ピッカーで別ディレクトリを選択 → 編集者名を入れて保存 → グラフに反映される。
- 追加したノードをクリック → ポップアップに README/プレビューと「解除」「このパスへ移動」が出る。
- 「解除」でリンクが消える。「このパスへ移動」でそのディレクトリに遷移する。
- スコープを「全て」「バケット単位」に切り替えると表示が変わる。

- [ ] **Step 8: commit**

```bash
git add front/pages/StorageBucket.tsx front/pages/StorageBucket.test.tsx front/App.css
git commit -m "feat: StorageBucket に家系図タブを追加する"
```
