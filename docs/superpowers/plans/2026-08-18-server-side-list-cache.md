# 一覧レスポンスのサーバー側キャッシュ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/list` と `/buckets` の応答を Postgres に 24 時間キャッシュし、`dataset` の 35 秒を「ブラウザごとに 6 時間に 1 回」から「全体で 24 時間に 1 回」に減らす。

**Architecture:** `api/lib/storage-cache.ts` を新設し、`storage_response_cache` テーブルを読み書きする。ルートには `Pool` を直接渡さず `ResponseCache` インターフェースを注入する (既存のルートテストが fake deps を組み立てる方式に合わせるため)。キャッシュ層は例外を飲み込んで `null` を返すので、DB が落ちてもリクエストは S3 経由で成立する。

**Tech Stack:** TypeScript / Hono / node-postgres (`pg`) / Vitest / aws-sdk-client-mock

**Spec:** `docs/superpowers/specs/2026-08-18-server-side-list-cache-design.md`

## Global Constraints

- サーバー側 TTL は **24 時間**。クライアント側の `LONG_CACHE_TTL_MS` (6 時間) は変更しない
- キャッシュ対象は `/list` と `/buckets` のみ。`/readme` は対象外
- **キャッシュはリクエストを壊さない**。読み書きの失敗はログを残して素通りする
- `force` (ページ送り用、クライアントキャッシュのみ迂回) と `refresh` (`↻` 用、サーバーキャッシュも貫通) を混同しない
- マイグレーションは `db/README.md` の規約に従い、自身で `OWNER` と `GRANT` を設定する
- 新しいミドルウェア (Redis 等) を追加しない
- コメントと文言は日本語。既存ファイルのコメント密度に合わせる

## テスト実行についての注意

`api/` の DB 依存テスト (`db.test.ts` / `storage.test.ts` など約 110 件) は、2026-08-18 時点でローカルの `dashboard_test` DB の資格情報がずれており `password authentication failed for user "dashboard_rw"` で失敗する。**これは本計画以前からの環境問題**である。

そのため本計画のテストは、Task 2 の 1 本を除きすべて **DB 不要**に設計してある (`Queryable` の fake を注入する)。Task 2 の DB 依存テストだけは以下が必要:

```bash
docker compose -f compose.dev.yaml down -v   # 警告: ローカル開発データが消える
docker compose -f compose.dev.yaml up -d
```

この復旧を行わない場合、Task 2 の DB 依存テストは skip し、SQL の正しさは Task 6 の本番受け入れ確認で担保する。

---

### Task 1: マイグレーションとキャッシュキー

**Files:**
- Create: `db/migrations/016_storage_response_cache.sql`
- Create: `api/lib/storage-cache.ts`
- Test: `api/lib/storage-cache.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `CacheKind`, `CacheScope`, `cacheKey(scope: CacheScope): string`, `LIST_CACHE_TTL_MS: number`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/storage-cache.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { cacheKey, LIST_CACHE_TTL_MS } from './storage-cache.js'

describe('cacheKey', () => {
  it('同じスコープからは同じキーが出る', () => {
    const a = cacheKey({ kind: 'list', connId: 'c1', bucket: 'b', prefix: 'p/' })
    const b = cacheKey({ kind: 'list', connId: 'c1', bucket: 'b', prefix: 'p/' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('kind / connId / bucket / prefix / recursive / cursor のどれが違ってもキーが変わる', () => {
    const base = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, kind: 'buckets' }),
      cacheKey({ ...base, connId: 'c2' }),
      cacheKey({ ...base, bucket: 'b2' }),
      cacheKey({ ...base, prefix: 'q/' }),
      cacheKey({ ...base, recursive: true }),
      cacheKey({ ...base, continuation: 'tok' }),
      cacheKey({ ...base, startAfter: 'k' }),
    ])
    expect(keys.size).toBe(8)
  })

  it('省略可能な項目は未指定と空文字を同じ扱いにする', () => {
    expect(cacheKey({ kind: 'buckets', connId: 'c1' }))
      .toBe(cacheKey({ kind: 'buckets', connId: 'c1', bucket: '', prefix: '' }))
  })

  it('TTL は 24 時間', () => {
    expect(LIST_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/storage-cache.test.ts`
Expected: FAIL — `Failed to resolve import "./storage-cache.js"`

- [ ] **Step 3: マイグレーションを書く**

`db/migrations/016_storage_response_cache.sql`:

```sql
-- /list と /buckets の応答キャッシュ (spec: 2026-08-18-server-side-list-cache-design.md)
--
-- mdx の dataset バケット (547,259 キー) は Delimiter 付き ListObjects に 35 秒
-- かかる。s3cmd でも同じ時間なのでアプリ側に改善余地はなく、応答を共有して
-- 「誰か一人が開けば全員速い」状態にするのがこのテーブルの目的。
--
-- cache_key は sha256(JSON([kind,connId,bucket,prefix,recursive,cursor])) の hex。
-- conn_id / bucket / prefix を別カラムでも持つのは、1 つの prefix が cursor 違いで
-- 複数行になるため。prefix 単位の無効化にはカラムでの絞り込みが要る。
CREATE TABLE IF NOT EXISTS storage_response_cache (
  cache_key  TEXT PRIMARY KEY,
  conn_id    TEXT NOT NULL,
  bucket     TEXT NOT NULL DEFAULT '',
  prefix     TEXT NOT NULL DEFAULT '',
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS storage_response_cache_scope
  ON storage_response_cache (conn_id, bucket, prefix);
CREATE INDEX IF NOT EXISTS storage_response_cache_expires
  ON storage_response_cache (expires_at);

ALTER TABLE storage_response_cache OWNER TO dashboard_rw;
GRANT SELECT ON storage_response_cache TO dashboard_ro;
```

- [ ] **Step 4: キャッシュキーを実装する**

`api/lib/storage-cache.ts`:

```typescript
import { createHash } from 'node:crypto'

// /list と /buckets の応答キャッシュ。
//
// 目的は「誰か一人が開けば全員速い」状態を作ること。mdx の dataset バケットは
// Delimiter 付き ListObjects に 35 秒かかり (547,259 キーの線形走査。s3cmd でも
// 同じなのでアプリ側に改善余地はない)、クライアント側の localStorage キャッシュ
// はブラウザごとにしか効かないため、人数分・端末分だけ 35 秒が発生していた。
//
// 書き込み先は storage_response_cache の 1 テーブルのみ。GET 経路が rw プールを
// 触ることになるが、影響範囲をこの 1 テーブルに閉じることで許容している
// (専用ロールを切る案は、稼働中 DB への手動 CREATE ROLE が必要なため見送り)。

export type CacheKind = 'list' | 'buckets'

export interface CacheScope {
  kind: CacheKind
  connId: string
  bucket?: string
  prefix?: string
  recursive?: boolean
  continuation?: string
  startAfter?: string
}

/** サーバー側 TTL。クライアント側の 6 時間とは役割が違う —
 *  クライアントは「即座に描画する」ため、こちらは「35 秒を全体で 1 回に減らす」ため。 */
export const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** sha256(JSON([...])) の hex。media_cache と同じ方式。
 *  省略可能な項目は空文字に正規化するので、未指定と '' は同じキーになる。 */
export function cacheKey(s: CacheScope): string {
  return createHash('sha256')
    .update(JSON.stringify([
      s.kind,
      s.connId,
      s.bucket ?? '',
      s.prefix ?? '',
      s.recursive ? 'r' : '',
      s.continuation ?? '',
      s.startAfter ?? '',
    ]))
    .digest('hex')
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd api && npx vitest run lib/storage-cache.test.ts`
Expected: PASS (4 件)

- [ ] **Step 6: コミット**

```bash
git add db/migrations/016_storage_response_cache.sql api/lib/storage-cache.ts api/lib/storage-cache.test.ts
git commit -m "feat(api): 一覧レスポンスキャッシュのテーブルとキー設計を追加する"
```

---

### Task 2: キャッシュの読み書きと無効化

**Files:**
- Modify: `api/lib/storage-cache.ts`
- Modify: `api/lib/storage-cache.test.ts`

**Interfaces:**
- Consumes: `cacheKey()`, `CacheScope`, `LIST_CACHE_TTL_MS` (Task 1)
- Produces:
  - `Queryable` — `{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }`
  - `ResponseCache` — `{ get(scope): Promise<unknown | null>; set(scope, payload): Promise<void>; invalidateScope(connId, bucket, prefix): Promise<void>; invalidateConnection(connId): Promise<void> }`
  - `createResponseCache(db: Queryable, ttlMs?: number): ResponseCache`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/storage-cache.test.ts` に追記:

```typescript
import { createResponseCache, type Queryable } from './storage-cache.js'

// 実 DB を使わずに SQL の呼ばれ方を検証するための fake。
// Pool は構造的にこの形に適合するので、本番では Pool をそのまま渡す。
function fakeDb(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = []
  const db: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows }
    },
  }
  return { db, calls }
}

const SCOPE = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }

describe('createResponseCache', () => {
  it('hit したら payload を返す', async () => {
    const { db, calls } = fakeDb([{ payload: { directories: ['p/x/'], files: [] } }])
    const cache = createResponseCache(db)
    expect(await cache.get(SCOPE)).toEqual({ directories: ['p/x/'], files: [] })
    // 期限切れを掴まないよう SQL 側で弾いていること
    expect(calls[0].text).toContain('expires_at > now()')
    expect(calls[0].values[0]).toBe(cacheKey(SCOPE))
  })

  it('行が無ければ null を返す (miss)', async () => {
    const { db } = fakeDb([])
    expect(await createResponseCache(db).get(SCOPE)).toBeNull()
  })

  it('set は conn_id / bucket / prefix も一緒に書き、TTL 後の期限を入れる', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db, 1000).set(SCOPE, { ok: true })
    expect(calls[0].text).toContain('ON CONFLICT (cache_key) DO UPDATE')
    expect(calls[0].values.slice(0, 4)).toEqual([cacheKey(SCOPE), 'c1', 'b', 'p/'])
    expect(calls[0].values[5]).toBe(1000)
  })

  it('invalidateScope は conn_id + bucket + prefix で消す', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db).invalidateScope('c1', 'b', 'p/')
    expect(calls[0].text).toContain('DELETE FROM storage_response_cache')
    expect(calls[0].values).toEqual(['c1', 'b', 'p/'])
  })

  it('invalidateConnection は conn_id の全行を消す', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db).invalidateConnection('c1')
    expect(calls[0].text).toContain('WHERE conn_id = $1')
    expect(calls[0].values).toEqual(['c1'])
  })

  // キャッシュはリクエストを壊さない。DB が落ちていても素通りさせる。
  it('DB が例外を投げても get は null を返す', async () => {
    const db: Queryable = { query: async () => { throw new Error('db down') } }
    expect(await createResponseCache(db).get(SCOPE)).toBeNull()
  })

  it('DB が例外を投げても set / invalidate は throw しない', async () => {
    const db: Queryable = { query: async () => { throw new Error('db down') } }
    const cache = createResponseCache(db)
    await expect(cache.set(SCOPE, { ok: true })).resolves.toBeUndefined()
    await expect(cache.invalidateScope('c1', 'b', 'p/')).resolves.toBeUndefined()
    await expect(cache.invalidateConnection('c1')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/storage-cache.test.ts`
Expected: FAIL — `createResponseCache is not a function`

- [ ] **Step 3: 実装する**

`api/lib/storage-cache.ts` に追記:

```typescript
/** node-postgres の Pool が構造的に満たす最小の形。
 *  これだけを要求することで、ユニットテストが実 DB 無しで書ける。 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface ResponseCache {
  get(scope: CacheScope): Promise<unknown | null>
  set(scope: CacheScope, payload: unknown): Promise<void>
  invalidateScope(connId: string, bucket: string, prefix: string): Promise<void>
  invalidateConnection(connId: string): Promise<void>
}

// キャッシュ層で例外を握りつぶす理由: 呼び出し側 (ルート) に try/catch を
// 散らすより 1 箇所に閉じ込めた方が「キャッシュは壊さない」が守りやすい。
// get が null を返せば呼び出し側は miss として S3 へ行くだけで済む。
function swallow(op: string, e: unknown): void {
  console.error(JSON.stringify({ ev: 'storage.cache.error', op, error: String(e) }))
}

export function createResponseCache(db: Queryable, ttlMs: number = LIST_CACHE_TTL_MS): ResponseCache {
  return {
    async get(scope) {
      try {
        const r = await db.query(
          `SELECT payload FROM storage_response_cache
            WHERE cache_key = $1 AND expires_at > now()`,
          [cacheKey(scope)],
        )
        const row = r.rows[0] as { payload: unknown } | undefined
        return row ? row.payload : null
      } catch (e) {
        swallow('get', e)
        return null
      }
    },

    async set(scope, payload) {
      try {
        // 期限切れ行は次回の取得時にこの UPSERT で上書きされるので、
        // 読み出し時の掃除も定期ジョブも要らない。
        await db.query(
          `INSERT INTO storage_response_cache
             (cache_key, conn_id, bucket, prefix, payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + ($6::bigint || ' milliseconds')::interval)
           ON CONFLICT (cache_key) DO UPDATE SET
             payload    = EXCLUDED.payload,
             fetched_at = now(),
             expires_at = EXCLUDED.expires_at`,
          [
            cacheKey(scope),
            scope.connId,
            scope.bucket ?? '',
            scope.prefix ?? '',
            JSON.stringify(payload),
            ttlMs,
          ],
        )
      } catch (e) {
        swallow('set', e)
      }
    },

    async invalidateScope(connId, bucket, prefix) {
      try {
        await db.query(
          `DELETE FROM storage_response_cache
            WHERE conn_id = $1 AND bucket = $2 AND prefix = $3`,
          [connId, bucket, prefix],
        )
      } catch (e) {
        swallow('invalidateScope', e)
      }
    },

    async invalidateConnection(connId) {
      try {
        await db.query('DELETE FROM storage_response_cache WHERE conn_id = $1', [connId])
      } catch (e) {
        swallow('invalidateConnection', e)
      }
    },
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/storage-cache.test.ts`
Expected: PASS (11 件)

**もし `createResponseCache(pools.rw)` で型エラーが出たら** (Task 3 Step 5 で判明する): `pg` の `Pool.query` はオーバーロードを持つため、構造的代入に失敗することがある。その場合は `Queryable` の `values` を緩める:

```typescript
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>
}
```

`Queryable` は「ユニットテストを実 DB 無しで書く」ためだけの型なので、ここを緩めても本番の型安全性は落ちない (呼び出し側の SQL と値は各メソッド内で閉じている)。

- [ ] **Step 5: 実 DB に対する疎通テストを書く (DB 必須)**

`api/lib/storage-cache.db.test.ts` を新規作成。**ローカル DB が壊れている場合はこの Step を飛ばし、Task 6 の本番受け入れ確認で担保する。**

```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createResponseCache, cacheKey } from './storage-cache.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

beforeEach(() => pools.rw.query('TRUNCATE storage_response_cache'))
afterAll(() => closePools(pools))

const SCOPE = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }

describe('storage_response_cache (実 DB)', () => {
  it('set した payload を get で取り戻せる', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set(SCOPE, { directories: ['p/x/'], files: [] })
    expect(await cache.get(SCOPE)).toEqual({ directories: ['p/x/'], files: [] })
  })

  it('TTL 切れの行は get で返らない', async () => {
    const cache = createResponseCache(pools.rw, -1000)  // 既に期限切れ
    await cache.set(SCOPE, { directories: [], files: [] })
    expect(await cache.get(SCOPE)).toBeNull()
  })

  it('invalidateScope は同 prefix の全ページを消す', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set({ ...SCOPE, continuation: 'tok1' }, { page: 1 })
    await cache.set({ ...SCOPE, continuation: 'tok2' }, { page: 2 })
    await cache.set({ ...SCOPE, prefix: 'other/' }, { page: 9 })
    await cache.invalidateScope('c1', 'b', 'p/')
    expect(await cache.get({ ...SCOPE, continuation: 'tok1' })).toBeNull()
    expect(await cache.get({ ...SCOPE, continuation: 'tok2' })).toBeNull()
    expect(await cache.get({ ...SCOPE, prefix: 'other/' })).toEqual({ page: 9 })
  })

  it('invalidateConnection は接続の全行を消す', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set(SCOPE, { page: 1 })
    await cache.set({ ...SCOPE, connId: 'c2' }, { page: 2 })
    await cache.invalidateConnection('c1')
    expect(await cache.get(SCOPE)).toBeNull()
    expect(await cache.get({ ...SCOPE, connId: 'c2' })).toEqual({ page: 2 })
  })
})
```

- [ ] **Step 6: DB 依存テストを実行 (DB が生きている場合のみ)**

Run: `cd api && npx vitest run lib/storage-cache.db.test.ts`
Expected: PASS (4 件)、または DB 未復旧なら接続エラーで FAIL — その場合はこのファイルを残したまま次へ進み、Task 6 で担保する

- [ ] **Step 7: コミット**

```bash
git add api/lib/storage-cache.ts api/lib/storage-cache.test.ts api/lib/storage-cache.db.test.ts
git commit -m "feat(api): 応答キャッシュの読み書きと無効化を実装する"
```

---

### Task 3: `/list` と `/buckets` にキャッシュを挟む

**Files:**
- Modify: `api/routes/storage-list.ts`
- Modify: `api/routes/storage-list.test.ts`
- Modify: `api/internal.ts`

**Interfaces:**
- Consumes: `ResponseCache`, `createResponseCache` (Task 2)
- Produces: `StorageListDeps` に `cache: ResponseCache` が加わる

- [ ] **Step 1: 失敗するテストを書く**

`api/routes/storage-list.test.ts` の先頭付近の deps 組み立てを差し替え、末尾に describe を追加:

```typescript
import type { ResponseCache } from '../lib/storage-cache.js'

// 既定は素通し (常に miss、書き込みは捨てる) のキャッシュ。
// 個々のテストで差し替えられるよう mutable にしておく。
let cache: ResponseCache = passthroughCache()

function passthroughCache(): ResponseCache {
  return {
    get: async () => null,
    set: async () => {},
    invalidateScope: async () => {},
    invalidateConnection: async () => {},
  }
}

const app = new Hono()
mountStorageListRoutes(app, {
  getStorage,
  getConnectionConfig,
  cache: { 
    get: s => cache.get(s),
    set: (s, p) => cache.set(s, p),
    invalidateScope: (c, b, p) => cache.invalidateScope(c, b, p),
    invalidateConnection: c => cache.invalidateConnection(c),
  },
})

beforeEach(() => {
  storageMock.reset()
  listObjectsVersion = 'v2'
  cache = passthroughCache()
})

describe('サーバー側キャッシュ', () => {
  it('hit したら S3 を呼ばずにキャッシュの中身を返す', async () => {
    const cached = { directories: ['cached/'], files: [], nextContinuation: null, nextStartAfter: null }
    cache = { ...passthroughCache(), get: async () => cached }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(storageMock.calls()).toHaveLength(0)
  })

  it('miss なら S3 を呼び、その応答を set する', async () => {
    storageMock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'b1/dir/' }], Contents: [], IsTruncated: false,
    })
    const sets: unknown[] = []
    cache = { ...passthroughCache(), set: async (_s, p) => { sets.push(p) } }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1`)
    expect(res.status).toBe(200)
    expect(storageMock.calls()).toHaveLength(1)
    expect(sets).toHaveLength(1)
    expect((sets[0] as { directories: string[] }).directories).toEqual(['b1/dir/'])
  })

  it('refresh=1 なら hit があっても無視して S3 を呼ぶ', async () => {
    storageMock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: 'b1/fresh/' }], Contents: [], IsTruncated: false,
    })
    let getCalled = false
    cache = {
      ...passthroughCache(),
      get: async () => { getCalled = true; return { directories: ['stale/'], files: [], nextContinuation: null, nextStartAfter: null } },
    }

    const res = await app.request(`/storage/${TEST_CONN_ID}/list?bucket=b1&refresh=1`)
    const body = await res.json() as { directories: string[] }
    expect(body.directories).toEqual(['b1/fresh/'])
    expect(getCalled).toBe(false)
    expect(storageMock.calls()).toHaveLength(1)
  })

  it('/buckets も同じくキャッシュを引く', async () => {
    const cached = { buckets: [{ name: 'from-cache', creationDate: null }] }
    cache = { ...passthroughCache(), get: async () => cached }

    const res = await app.request(`/storage/${TEST_CONN_ID}/buckets`)
    expect(await res.json()).toEqual(cached)
    expect(storageMock.calls()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run routes/storage-list.test.ts`
Expected: FAIL — `cache` が `StorageListDeps` に無く型エラー、および新規 4 件が失敗

- [ ] **Step 3: ルートにキャッシュを組み込む**

`api/routes/storage-list.ts` の `StorageListDeps` に追加:

```typescript
import type { CacheScope, ResponseCache } from '../lib/storage-cache.js'

export interface StorageListDeps {
  getStorage: GetStorage
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
  /** /list と /buckets の応答キャッシュ。失敗は内部で握りつぶされるので
   *  呼び出し側は try/catch を書かない。 */
  cache: ResponseCache
}
```

`/buckets` ハンドラの `const out = await storage.send(new ListBucketsCommand({}))` の直前に挿入:

```typescript
    const scope: CacheScope = { kind: 'buckets', connId: c.req.param('connId') }
    const refresh = c.req.query('refresh') === '1'
    if (!refresh) {
      const hit = await deps.cache.get(scope)
      if (hit) return c.json(hit)
    }
```

そして `return c.json({ buckets: ... })` を差し替え:

```typescript
    const body = {
      buckets: (out.Buckets ?? []).map(b => ({
        name: b.Name!,
        creationDate: b.CreationDate?.toISOString() ?? null,
      })),
    }
    await deps.cache.set(scope, body)
    return c.json(body)
```

`/list` ハンドラでは `const config = await deps.getConnectionConfig(connId)` の直前に挿入:

```typescript
    const scope: CacheScope = {
      kind: 'list', connId, bucket, prefix, recursive, continuation, startAfter,
    }
    const refresh = c.req.query('refresh') === '1'
    if (!refresh) {
      const hit = await deps.cache.get(scope)
      if (hit) return c.json(hit)
    }
```

v1 / v2 それぞれの `return c.json({...})` を、いったん `body` に束ねてから `set` する形に変える。v1 側:

```typescript
      const body = {
        directories: (out.CommonPrefixes ?? []).map(p => p.Prefix!).filter(Boolean),
        files: rawContents
          .filter(o => o.Key && !isSelfPlaceholder(o.Key, prefix))
          .map(o => ({
            key: o.Key!,
            size: o.Size ?? 0,
            lastModified: o.LastModified?.toISOString() ?? null,
          })),
        nextContinuation: explicitNext,
        nextStartAfter: fallbackKey,
      }
      await deps.cache.set(scope, body)
      return c.json(body)
```

v2 側も同様に `body` へ束ねて `await deps.cache.set(scope, body)` してから返す。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run routes/storage-list.test.ts`
Expected: PASS (既存 + 新規 4 件)

- [ ] **Step 5: 本番の組み立てに配線する**

`api/internal.ts` の `mountStorageListRoutes(api, {` の呼び出しに `cache` を渡す。ファイル上部に import を追加:

```typescript
import { createResponseCache } from './lib/storage-cache.js'
```

`const storageFactory = ...` の下に:

```typescript
// 応答キャッシュは書き込みを伴うので rw プールを使う。書き込み先は
// storage_response_cache の 1 テーブルのみ (spec の「ロールについての判断」)。
const responseCache = createResponseCache(pools.rw)
```

`mountStorageListRoutes(api, { ... })` の deps に `cache: responseCache,` を追加。

- [ ] **Step 6: 型検査とテスト一式**

Run: `cd api && npx tsc --noEmit && npx vitest run routes/storage-list.test.ts lib/storage-cache.test.ts`
Expected: 型エラー無し、テスト PASS

- [ ] **Step 7: コミット**

```bash
git add api/routes/storage-list.ts api/routes/storage-list.test.ts api/internal.ts
git commit -m "feat(api): /list と /buckets の応答をサーバー側でキャッシュする"
```

---

### Task 4: `force` と `refresh` を分離する (フロント)

**Files:**
- Modify: `front/lib/api/client.ts`
- Modify: `front/components/StorageBrowser.tsx`
- Modify: `front/pages/StorageIndex.tsx`
- Modify: `front/components/StorageBrowser.test.tsx`

**Interfaces:**
- Consumes: Task 3 の `refresh=1` クエリパラメータ
- Produces: `api.list(..., { refresh?: boolean })`, `api.buckets(connId, { refresh?: boolean })`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/StorageBrowser.test.tsx` の末尾に追加:

```typescript
describe('force と refresh の分離', () => {
  it('↻ はサーバーキャッシュを貫通させる (refresh: true)', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValue({
      directories: [], files: [], nextContinuation: null, nextStartAfter: null,
    })
    const user = userEvent.setup()
    renderBrowser('voice/')
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1][4]).toMatchObject({ refresh: true })
  })

  it('ページ送りはサーバーキャッシュを貫通させない (force のみ)', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValueOnce({
      directories: [], files: [{ key: 'voice/p1.mp3', size: 1, lastModified: null }],
      nextContinuation: 'tok1', nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: [], files: [{ key: 'voice/p2.mp3', size: 1, lastModified: null }],
      nextContinuation: null, nextStartAfter: null,
    })
    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByText(/p1\.mp3/)

    await user.click(screen.getByRole('button', { name: '次のページへ' }))
    await screen.findByText(/p2\.mp3/)
    const opts = listMock.mock.calls[1][4] as { force?: boolean; refresh?: boolean }
    expect(opts.force).toBe(true)
    expect(opts.refresh).toBeUndefined()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd front && npx vitest run components/StorageBrowser.test.tsx`
Expected: FAIL — `refresh` が渡っておらず `toMatchObject({ refresh: true })` が失敗

- [ ] **Step 3: client.ts に refresh を通す**

`front/lib/api/client.ts` の `list` の opts 型に `refresh?: boolean` を追加:

```typescript
    opts: { recursive?: boolean; force?: boolean; refresh?: boolean }
      & Revalidatable<z.infer<typeof StorageList>> = {},
```

`buildUrl` の params に追加 (`recursive` の次の行):

```typescript
        refresh: opts.refresh ? '1' : undefined,
```

`buckets` も同様に:

```typescript
  buckets: (
    connId: string,
    opts: { refresh?: boolean } & Revalidatable<z.infer<typeof ListBuckets>> = {},
  ) =>
    bucketsCache.get(
      k('buckets', connId),
      () => getJson(
        buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/buckets`,
          { refresh: opts.refresh ? '1' : undefined }),
        ListBuckets,
      ),
      opts.onRevalidate,
    ),
```

**注意**: `refresh` はキャッシュキーに含めない。`api.list` の `cacheKey` を組み立てている行 (`const cacheKey = k('list', ...)`) は変更しないこと。含めると `↻` の結果が別エントリに入って表示に反映されない。

- [ ] **Step 4: StorageBrowser で ↻ だけ refresh を渡す**

`front/components/StorageBrowser.tsx` の `load` のシグネチャを変える:

```typescript
  const load = useCallback((cursor: Cursor, opts: { force?: boolean; refresh?: boolean } = {}) => {
```

`api.list(...)` の opts に追加 (`force: opts.force,` の次の行):

```typescript
      refresh: opts.refresh,
```

`forceRefresh` を変更:

```typescript
  // 当該ディレクトリ全体のキャッシュを破棄して 1 ページ目から再 fetch。
  // refresh:true でサーバー側キャッシュも貫通する — これが無いとユーザーは
  // 最大 24 時間 古いデータから逃げられない。
  const forceRefresh = (): void => {
    api.invalidateList(connId, bucket, prefix)
    dispatch({ type: 'identityReset' })
    load({}, { refresh: true })
  }
```

`next()` 内の `load(c, { force: true })` は**変更しない**。ページ送りでサーバーを貫通させると `dataset` で 1 ページごとに 35 秒かかる。

- [ ] **Step 5: StorageIndex の ↻ にも渡す**

`front/pages/StorageIndex.tsx` の `refresh` を `useCallback((opts: { refresh?: boolean } = {}) => {` に変え、`api.buckets(connId, {` の第 2 引数に `refresh: opts.refresh,` を追加。`forceRefresh` を変更:

```typescript
    const forceRefresh = useCallback(() => {
        api.invalidateBuckets(connId)
        api.invalidateFavorites(connId)
        refresh({ refresh: true })
    }, [connId, refresh])
```

`useEffect(() => { refresh() }, [refresh])` は引数なしのままにする (通常のロードは貫通させない)。

- [ ] **Step 6: テストが通ることを確認**

Run: `cd front && npx tsc --noEmit && npx vitest run`
Expected: 型エラー無し、全テスト PASS

- [ ] **Step 7: コミット**

```bash
git add front/lib/api/client.ts front/components/StorageBrowser.tsx front/pages/StorageIndex.tsx front/components/StorageBrowser.test.tsx
git commit -m "feat(front): ↻ だけがサーバーキャッシュを貫通するようにする"
```

---

### Task 5: 無効化を配線する

**Files:**
- Modify: `api/routes/storage-readme.ts`
- Modify: `api/routes/connections.ts`
- Modify: `api/internal.ts`
- Modify: `api/routes/storage-readme.test.ts`

**Interfaces:**
- Consumes: `ResponseCache` (Task 2)
- Produces: なし (既存の deps に `cache` が増えるのみ)

- [ ] **Step 1: 失敗するテストを書く**

まず `api/routes/storage-readme.test.ts` の冒頭に、差し替え可能な fake キャッシュを用意する (Task 3 で `storage-list.test.ts` に入れたものと同じ形):

```typescript
import type { ResponseCache } from '../lib/storage-cache.js'

function passthroughCache(): ResponseCache {
  return {
    get: async () => null,
    set: async () => {},
    invalidateScope: async () => {},
    invalidateConnection: async () => {},
  }
}

let cache: ResponseCache = passthroughCache()
```

既存の `mountStorageReadmeRoutes(app, { ... })` の deps に、可変変数を経由する形で渡す:

```typescript
  cache: {
    get: s => cache.get(s),
    set: (s, p) => cache.set(s, p),
    invalidateScope: (c, b, p) => cache.invalidateScope(c, b, p),
    invalidateConnection: c => cache.invalidateConnection(c),
  },
```

既存の `beforeEach` に `cache = passthroughCache()` を追加する。そのうえでテストを追加:

```typescript
it('README を書いたら同 prefix の一覧キャッシュを消す', async () => {
  const invalidated: [string, string, string][] = []
  cache = {
    ...passthroughCache(),
    invalidateScope: async (c, b, p) => { invalidated.push([c, b, p]) },
  }

  storageMock.on(PutObjectCommand).resolves({})
  const res = await app.request(`/storage/${TEST_CONN_ID}/readme?bucket=b1&prefix=p/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '# hello', editor: 'tester' }),
  })
  expect(res.status).toBe(200)
  expect(invalidated).toEqual([[TEST_CONN_ID, 'b1', 'p/']])
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run routes/storage-readme.test.ts`
Expected: FAIL — `invalidated` が空配列

- [ ] **Step 3: readme の PUT に無効化を足す**

`api/routes/storage-readme.ts` の deps に `cache: ResponseCache` を追加し、`PUT` ハンドラの `return c.json({ ok: true, ... })` の直前に:

```typescript
    // README.md が一覧に現れる / 消えるので、この prefix の一覧キャッシュを捨てる。
    await deps.cache.invalidateScope(connId, bucket, prefix)
```

- [ ] **Step 4: 接続の更新・削除に無効化を足す**

`api/routes/connections.ts` は既に `deps.invalidate(id)` を 316 行 (PUT) と 336 行 (DELETE) で呼んでいる。`api/internal.ts` でこの `invalidate` に渡している関数を拡張する:

```typescript
  invalidate: (id: string) => {
    storageFactory.invalidate(id)
    // endpoint や list_objects_version が変われば応答が変わるので、
    // この接続の一覧キャッシュは全部捨てる。await しないのは
    // 既存の invalidate が同期シグネチャのため (失敗は内部でログ済み)。
    void responseCache.invalidateConnection(id)
  },
```

`api/internal.ts` の `mountStorageReadmeRoutes(api, { getStorage: storageFactory.getStorage, pools })` に `cache: responseCache` を追加。

- [ ] **Step 5: テストと型検査**

Run: `cd api && npx tsc --noEmit && npx vitest run routes/`
Expected: 型エラー無し、DB 非依存のテストは PASS

- [ ] **Step 6: コミット**

```bash
git add api/routes/storage-readme.ts api/routes/connections.ts api/internal.ts api/routes/storage-readme.test.ts
git commit -m "feat(api): README 書き込みと接続変更で一覧キャッシュを無効化する"
```

---

### Task 6: 本番適用と受け入れ確認

**Files:**
- Modify: `db/README.md` (適用済みマイグレーションの記録が必要な場合)

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces: なし

- [ ] **Step 1: 全体の検査**

```bash
cd api && npx tsc --noEmit && cd ../front && npx tsc --noEmit && npx vitest run
```
Expected: 型エラー無し、front は全 PASS

- [ ] **Step 2: push**

```bash
git push origin main
```

- [ ] **Step 3: 本番 DB にマイグレーションを適用する**

`db/init/00-init.sh` はボリューム初回作成時にしか走らないので、**稼働中の DB には手動適用が必要**。`db/README.md` の手順に従い、先にバックアップを取る。

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc \
  'cd ~/mado && docker compose -f compose.prod.yaml exec -T postgres \
     pg_dump -U postgres -d dashboard > ~/dashboard-backup-$(date +%Y%m%d-%H%M).sql'
```

デプロイ (= `git pull`) でマイグレーションファイルがホストに届いてから適用する。

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc \
  'cd ~/mado && git pull origin main && docker compose -f compose.prod.yaml exec -T postgres \
     psql -v ON_ERROR_STOP=1 -U postgres -d dashboard -f /migrations/016_storage_response_cache.sql'
```

Expected: `CREATE TABLE` / `CREATE INDEX` × 2 / `ALTER TABLE` / `GRANT`

- [ ] **Step 4: デプロイ**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc 'cd ~/mado && ./deploy.sh'
```

Expected: exit 0。`| tail` を挟まないこと (終了コードが握り潰される)

- [ ] **Step 5: 受け入れ確認を実測する**

ホスト上で以下を順に実行し、spec の受け入れ基準を満たすことを確認する。

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc '
U=http://localhost/api/internal/storage/mW5dNSSMcQ/list
curl -s -o /dev/null -w "1回目 (S3 まで)      -> %{http_code} (%{time_total}s)\n" --max-time 120 "$U?bucket=dataset"
curl -s -o /dev/null -w "2回目 (キャッシュ)    -> %{http_code} (%{time_total}s)\n" --max-time 120 "$U?bucket=dataset"
curl -s -o /dev/null -w "refresh=1 (貫通)     -> %{http_code} (%{time_total}s)\n" --max-time 120 "$U?bucket=dataset&refresh=1"
curl -s -o /dev/null -w "速いバケット (退行確認) -> %{http_code} (%{time_total}s)\n" --max-time 60 "$U?bucket=trash"
'
```

Expected:
- 1 回目: 200 / 約 35 秒
- 2 回目: 200 / **0.1 秒台**
- `refresh=1`: 200 / 約 35 秒 (貫通している)
- `trash`: 200 / 0.1 秒未満

- [ ] **Step 6: キャッシュ行が入っていることを確認**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc '
cd ~/mado && docker compose -f compose.prod.yaml exec -T postgres psql -U postgres -d dashboard -Atc \
  "SELECT count(*), pg_size_pretty(pg_total_relation_size(\$\$storage_response_cache\$\$)) FROM storage_response_cache;"'
```

Expected: 行数 1 以上、サイズは数十 KB 程度

- [ ] **Step 7: ブラウザで一覧を開き、キャッシュバナーの挙動を確認**

`dataset` を開いたときに、テーブルヘッダ上のバナーが「取得時刻 + 更新中」を出し、更新完了で 1 行に退くこと。サーバーキャッシュが当たると再検証が速く終わるため、バナーは 200ms の遅延表示によりほとんど出ないのが正常。

