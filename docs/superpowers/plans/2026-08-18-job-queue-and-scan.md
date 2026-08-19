# 汎用ジョブキュー + ディレクトリ走査 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 種別に依存しないジョブキューを作り、その最初の利用者としてディレクトリ配下のオブジェクト数・サイズの走査を載せる。

**Architecture:** Postgres の `jobs` テーブルを `SKIP LOCKED` で claim する自前キュー。worker (`media-worker` コンテナ) が 1 件ずつ実行する。ジョブ種別は `kind → handler` のマップで解決し、新種別はハンドラ関数を 1 つ書いて 1 行登録するだけで足せる。フロントは実行中のみ 1 秒間隔でポーリングする。

**Tech Stack:** TypeScript / Hono / node-postgres (`pg`) / Vitest / aws-sdk-client-mock / React

**Spec:**
- `docs/superpowers/specs/2026-08-18-job-queue-design.md` (基盤)
- `docs/superpowers/specs/2026-08-18-directory-scan-design.md` (最初のジョブ種別)

## Global Constraints

- **ジョブ基盤に新しい依存を入れない**。pg-boss 等は使わず自前。`api/` の依存は 8 個のまま
- **進捗にパーセンテージを強制しない**。`JobProgress` は `count` と `ratio` の判別可能なユニオン。走査は `count` を返す
- **進捗の書き込みは最大 2 秒に 1 回**に間引く。ハンドラは呼び放題でよい
- **`attempts >= 3` で `error`**。poison job を無限に再投入しない
- **種別ごとの結果テーブルを作らない**。結果は `jobs.result`、最新結果は「最後に成功したジョブ」
- **汎用の `POST /jobs` は作らない**。投入は種別ごとのエンドポイント
- マイグレーションは `db/README.md` の規約に従い、自身で `OWNER` と `GRANT` を設定する。`SERIAL` を使う場合は `ALTER SEQUENCE ... OWNER TO` も書く
- `jobs.id` は `SERIAL` (int4)。pg ドライバは int8 を文字列で返し、フロントの `z.number()` と揃わないため
- コメントと文言は日本語。既存ファイルのコメント密度に合わせる

## テスト実行

`npm test` は `../.env` を読むようになっている (`08082cf`)。DB 依存テストはそのまま動く。

```bash
cd api && npm test
```

動かない場合、`.env` の `DATABASE_URL_RW_TEST` のパスワードが `DASHBOARD_PASSWORD` と一致しているか確認する (`.env.example` に注記あり)。認証エラーなら DB は正常で、接続文字列がずれているだけ。

## ファイル構成

| ファイル | 責務 |
| --- | --- |
| `db/migrations/017_jobs.sql` | `jobs` テーブル |
| `db/migrations/018_bucket_settings.sql` | `bucket_settings` テーブル |
| `api/lib/jobs.ts` | ジョブの永続化 (enqueue / claim / heartbeat / finish / cancel / latest / 保持) と型 |
| `api/lib/job-runner.ts` | ループ、ハンドラ登録、`JobContext`、進捗の間引き、キャンセルの伝播 |
| `api/lib/scan.ts` | 走査の集計 (純関数)。S3 を知らない |
| `api/lib/scan-handler.ts` | `storage.scan` ハンドラ。S3 ページング + `scan.ts` の集計 |
| `api/lib/bucket-settings.ts` | バケット設定の読み書き |
| `api/routes/jobs.ts` | `GET /jobs/:id`、`POST /jobs/:id/cancel`、`GET /jobs/latest` |
| `api/routes/storage-scan.ts` | `POST /storage/:connId/scan` (投入 + `scan_enabled` ガード) |
| `front/components/storage/ScanModal.tsx` | 走査モーダル |

`scan.ts` と `scan-handler.ts` を分けるのは、集計ロジックを S3 抜きで単体テストするため。

---

### Task 1: jobs テーブルと投入・取得

**Files:**
- Create: `db/migrations/017_jobs.sql`
- Create: `api/lib/jobs.ts`
- Test: `api/lib/jobs.test.ts`

**Interfaces:**
- Consumes: `Pools` from `api/db.js` (`{ rw: Pool; ro: Pool }`)
- Produces:
  - `JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'`
  - `JobProgress = { kind: 'count'; done: number; label?: string } | { kind: 'ratio'; done: number; total: number; label?: string }`
  - `JobRow = { id: number; kind: string; dedupKey: string; payload: unknown; status: JobStatus; progress: JobProgress | null; result: unknown; error: string | null; attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null }`
  - `createJobStore(pools: Pools): JobStore`
  - `JobStore.enqueue(kind: string, dedupKey: string, payload: unknown): Promise<number>`
  - `JobStore.get(id: number): Promise<JobRow | null>`
  - `JobStore.latestDone(kind: string, dedupKey: string): Promise<JobRow | null>`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/jobs.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createJobStore } from './jobs.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const store = createJobStore(pools)

beforeEach(() => pools.rw.query('TRUNCATE jobs'))
afterAll(() => closePools(pools))

describe('enqueue / get', () => {
  it('投入した内容を id で引き戻せる', async () => {
    const id = await store.enqueue('storage.scan', 'c1\nb\np/', { connId: 'c1' })
    const job = await store.get(id)
    expect(job).toMatchObject({
      id, kind: 'storage.scan', dedupKey: 'c1\nb\np/', status: 'queued', attempts: 0,
    })
    expect(job!.payload).toEqual({ connId: 'c1' })
  })

  it('存在しない id は null', async () => {
    expect(await store.get(999999)).toBeNull()
  })

  // 部分一意インデックスによる合流。二重投入で行を増やさない。
  it('実行中の同一対象を再投入すると既存の id が返る', async () => {
    const a = await store.enqueue('storage.scan', 'same', {})
    const b = await store.enqueue('storage.scan', 'same', {})
    expect(b).toBe(a)
    const n = await pools.rw.query('SELECT count(*)::int AS c FROM jobs')
    expect(n.rows[0].c).toBe(1)
  })

  it('kind が違えば別ジョブになる', async () => {
    const a = await store.enqueue('storage.scan', 'same', {})
    const b = await store.enqueue('other.kind', 'same', {})
    expect(b).not.toBe(a)
  })

  it('latestDone は最後に成功したジョブを返す', async () => {
    const old = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', result='{"n":1}', finished_at=now() - interval '1 hour' WHERE id=$1`, [old])
    const recent = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', result='{"n":2}', finished_at=now() WHERE id=$1`, [recent])

    const job = await store.latestDone('storage.scan', 'k')
    expect(job!.id).toBe(recent)
    expect(job!.result).toEqual({ n: 2 })
  })

  it('latestDone は done 以外を拾わない', async () => {
    const id = await store.enqueue('storage.scan', 'k', {})
    await pools.rw.query(`UPDATE jobs SET status='error', finished_at=now() WHERE id=$1`, [id])
    expect(await store.latestDone('storage.scan', 'k')).toBeNull()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: FAIL — `Failed to resolve import "./jobs.js"`

- [ ] **Step 3: マイグレーションを書く**

`db/migrations/017_jobs.sql`:

```sql
-- 汎用ジョブキュー (spec: 2026-08-18-job-queue-design.md)
--
-- 数分〜数十分かかる処理を HTTP 接続を保持せずに実行するための土台。
-- 種別は kind で判別し、worker 側の kind → handler マップで解決する。
--
-- 同種の基盤は 9cd6881 で「UI / ジョブ管理が煩雑」として一度削除された。
-- 再導入にあたり、進捗にパーセンテージを強制しない・attempts で poison job を
-- 打ち切る・種別ごとの結果テーブルを作らない、の 3 点を変えている。
CREATE TABLE IF NOT EXISTS jobs (
  -- SERIAL (int4): pg ドライバは int8 を string で返すため、フロントの
  -- z.number() と揃えて int4 にする (旧 media_jobs と同じ判断)。
  id           SERIAL      PRIMARY KEY,
  kind         TEXT        NOT NULL,
  -- 同一対象の判定に使う。意味は種別ごとに決める (走査なら connId/bucket/prefix)。
  dedup_key    TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','error','canceled')),
  progress     JSONB,
  result       JSONB,
  error        TEXT,
  attempts     INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

-- 実行中 (queued/running) の同一対象は 1 本に合流させる。
-- done/error/canceled の行が残っていても再投入はできる。
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active
  ON jobs (kind, dedup_key) WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS jobs_claim
  ON jobs (created_at) WHERE status = 'queued';

-- 「最後に成功したジョブ」を引く用。結果ストアを兼ねる。
CREATE INDEX IF NOT EXISTS jobs_latest
  ON jobs (kind, dedup_key, finished_at DESC) WHERE status = 'done';

ALTER TABLE    jobs        OWNER TO dashboard_rw;
ALTER SEQUENCE jobs_id_seq OWNER TO dashboard_rw;
GRANT SELECT ON jobs TO dashboard_ro;
```

- [ ] **Step 4: dev DB にマイグレーションを流す**

新しいマイグレーションはボリューム初回作成時しか自動適用されないので、稼働中の dev DB には手で当てる。

```bash
for db in dashboard dashboard_test; do
  docker compose -f compose.dev.yaml exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d $db -f /migrations/017_jobs.sql
done
```
Expected: `CREATE TABLE` / `CREATE INDEX` × 3 / `ALTER TABLE` / `ALTER SEQUENCE` / `GRANT` が 2 回

- [ ] **Step 5: 実装する**

`api/lib/jobs.ts`:

```typescript
import type { Pools } from '../db.js'

// 汎用ジョブキューの永続化層 (spec: 2026-08-18-job-queue-design.md)。
// ループとハンドラ実行は job-runner.ts が持ち、ここは SQL だけに閉じる。

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

/** 進捗。総数が分からない処理があるので、パーセンテージを強制しない。
 *  S3 には件数を返す API が無く、初回の走査では分母が原理的に出せない。 */
export type JobProgress =
  | { kind: 'count'; done: number; label?: string }
  | { kind: 'ratio'; done: number; total: number; label?: string }

export interface JobRow {
  id: number
  kind: string
  dedupKey: string
  payload: unknown
  status: JobStatus
  progress: JobProgress | null
  result: unknown
  error: string | null
  attempts: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface DbJobRow {
  id: number
  kind: string
  dedup_key: string
  payload: unknown
  status: JobStatus
  progress: JobProgress | null
  result: unknown
  error: string | null
  attempts: number
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const COLUMNS = `id, kind, dedup_key, payload, status, progress, result, error,
                 attempts, created_at, started_at, finished_at`

function toRow(r: DbJobRow): JobRow {
  return {
    id: r.id,
    kind: r.kind,
    dedupKey: r.dedup_key,
    payload: r.payload,
    status: r.status,
    progress: r.progress,
    result: r.result,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  }
}

export interface JobStore {
  enqueue(kind: string, dedupKey: string, payload: unknown): Promise<number>
  get(id: number): Promise<JobRow | null>
  latestDone(kind: string, dedupKey: string): Promise<JobRow | null>
}

export function createJobStore(pools: Pools): JobStore {
  return {
    /** 実行中の同一対象があれば新規作成せずその id を返す (部分一意インデックスで合流)。 */
    async enqueue(kind, dedupKey, payload) {
      const r = await pools.rw.query<{ id: number }>(
        `INSERT INTO jobs (kind, dedup_key, payload) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [kind, dedupKey, JSON.stringify(payload)],
      )
      if (r.rows[0]) return r.rows[0].id

      // 競合 = 実行中の同一対象が既にある。その id を返す。
      const existing = await pools.rw.query<{ id: number }>(
        `SELECT id FROM jobs
          WHERE kind = $1 AND dedup_key = $2 AND status IN ('queued','running')`,
        [kind, dedupKey],
      )
      return existing.rows[0].id
    },

    async get(id) {
      const r = await pools.ro.query<DbJobRow>(
        `SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id])
      return r.rows[0] ? toRow(r.rows[0]) : null
    },

    async latestDone(kind, dedupKey) {
      const r = await pools.ro.query<DbJobRow>(
        `SELECT ${COLUMNS} FROM jobs
          WHERE kind = $1 AND dedup_key = $2 AND status = 'done'
          ORDER BY finished_at DESC LIMIT 1`,
        [kind, dedupKey],
      )
      return r.rows[0] ? toRow(r.rows[0]) : null
    },
  }
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: PASS (6 件)

- [ ] **Step 7: コミット**

```bash
git add db/migrations/017_jobs.sql api/lib/jobs.ts api/lib/jobs.test.ts
git commit -m "feat(api): 汎用ジョブキューのテーブルと投入・取得を追加する"
```

---

### Task 2: claim / heartbeat / 完了 / キャンセル

**Files:**
- Modify: `api/lib/jobs.ts`
- Modify: `api/lib/jobs.test.ts`

**Interfaces:**
- Consumes: `JobStore`, `JobRow`, `JobProgress` (Task 1)
- Produces (すべて `JobStore` のメソッド):
  - `claim(): Promise<{ id: number; kind: string; payload: unknown } | null>`
  - `heartbeat(id: number, progress: JobProgress | null): Promise<void>`
  - `finish(id: number, result: unknown): Promise<void>`
  - `fail(id: number, message: string): Promise<void>`
  - `cancel(id: number): Promise<void>`
  - `isCanceled(id: number): Promise<boolean>`
  - `requeueStale(staleAfterSec: number, maxAttempts: number): Promise<number>`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/jobs.test.ts` に追記:

```typescript
describe('claim / 完了', () => {
  it('queued を 1 件 claim して running にする', async () => {
    const id = await store.enqueue('k', 'd', { a: 1 })
    const job = await store.claim()
    expect(job).toMatchObject({ id, kind: 'k' })
    expect(job!.payload).toEqual({ a: 1 })
    const after = await store.get(id)
    expect(after!.status).toBe('running')
    expect(after!.attempts).toBe(1)
  })

  it('queued が無ければ null', async () => {
    expect(await store.claim()).toBeNull()
  })

  it('同じジョブを二重に claim しない', async () => {
    await store.enqueue('k', 'd', {})
    expect(await store.claim()).not.toBeNull()
    expect(await store.claim()).toBeNull()
  })

  it('古い queued から順に取る', async () => {
    const first = await store.enqueue('k', 'd1', {})
    await pools.rw.query(`UPDATE jobs SET created_at = now() - interval '1 hour' WHERE id=$1`, [first])
    await store.enqueue('k', 'd2', {})
    expect((await store.claim())!.id).toBe(first)
  })

  it('finish で done と result が入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.finish(id, { total: 42 })
    const job = await store.get(id)
    expect(job!.status).toBe('done')
    expect(job!.result).toEqual({ total: 42 })
    expect(job!.finishedAt).not.toBeNull()
  })

  it('fail で error とメッセージが入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.fail(id, 'S3 が落ちています')
    const job = await store.get(id)
    expect(job!.status).toBe('error')
    expect(job!.error).toBe('S3 が落ちています')
  })

  it('heartbeat で進捗が入る', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.heartbeat(id, { kind: 'count', done: 1200 })
    expect((await store.get(id))!.progress).toEqual({ kind: 'count', done: 1200 })
  })
})

describe('キャンセル', () => {
  it('cancel で canceled になり isCanceled が true', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    expect(await store.isCanceled(id)).toBe(false)
    await store.cancel(id)
    expect((await store.get(id))!.status).toBe('canceled')
    expect(await store.isCanceled(id)).toBe(true)
  })

  it('done のジョブは cancel しても done のまま', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await store.finish(id, {})
    await store.cancel(id)
    expect((await store.get(id))!.status).toBe('done')
  })
})

describe('requeueStale', () => {
  it('heartbeat が途絶えた running を queued に戻す', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    await pools.rw.query(`UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id=$1`, [id])
    expect(await store.requeueStale(120, 3)).toBe(1)
    expect((await store.get(id))!.status).toBe('queued')
  })

  it('heartbeat が新しければ戻さない', async () => {
    const id = await store.enqueue('k', 'd', {})
    await store.claim()
    expect(await store.requeueStale(120, 3)).toBe(0)
    expect((await store.get(id))!.status).toBe('running')
  })

  // poison job (worker を必ず落とすジョブ) を無限に再投入しないための打ち切り。
  it('attempts が上限に達したら error にする', async () => {
    const id = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='running', attempts=3, heartbeat_at=now() - interval '10 minutes' WHERE id=$1`, [id])
    expect(await store.requeueStale(120, 3)).toBe(1)
    const job = await store.get(id)
    expect(job!.status).toBe('error')
    expect(job!.error).toContain('繰り返し')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: FAIL — `store.claim is not a function`

- [ ] **Step 3: 実装する**

`api/lib/jobs.ts` の `JobStore` インターフェースに追加:

```typescript
  /** queued を 1 件 running にして返す。無ければ null。 */
  claim(): Promise<{ id: number; kind: string; payload: unknown } | null>
  heartbeat(id: number, progress: JobProgress | null): Promise<void>
  finish(id: number, result: unknown): Promise<void>
  fail(id: number, message: string): Promise<void>
  cancel(id: number): Promise<void>
  isCanceled(id: number): Promise<boolean>
  /** heartbeat の途絶えた running を queued に戻す。上限到達分は error にする。
   *  戻り値は処理した件数。 */
  requeueStale(staleAfterSec: number, maxAttempts: number): Promise<number>
```

`createJobStore` の返却オブジェクトに追加:

```typescript
    // SKIP LOCKED なので、将来 worker を増やしても取り合いにならない。
    async claim() {
      const r = await pools.rw.query<{ id: number; kind: string; payload: unknown }>(
        `UPDATE jobs SET status = 'running', started_at = now(), heartbeat_at = now(),
                         attempts = attempts + 1
          WHERE id = (
            SELECT id FROM jobs WHERE status = 'queued'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING id, kind, payload`,
      )
      return r.rows[0] ?? null
    },

    async heartbeat(id, progress) {
      await pools.rw.query(
        `UPDATE jobs SET heartbeat_at = now(), progress = COALESCE($2::jsonb, progress)
          WHERE id = $1 AND status = 'running'`,
        [id, progress === null ? null : JSON.stringify(progress)],
      )
    },

    async finish(id, result) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'done', result = $2, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(result)],
      )
    },

    async fail(id, message) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'error', error = $2, finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [id, message],
      )
    },

    // 終端状態のジョブは触らない (done を canceled に落とさない)。
    async cancel(id) {
      await pools.rw.query(
        `UPDATE jobs SET status = 'canceled', finished_at = now()
          WHERE id = $1 AND status IN ('queued','running')`,
        [id],
      )
    },

    async isCanceled(id) {
      const r = await pools.ro.query<{ status: JobStatus }>(
        'SELECT status FROM jobs WHERE id = $1', [id])
      return r.rows[0]?.status === 'canceled'
    },

    async requeueStale(staleAfterSec, maxAttempts) {
      const stale = `now() - make_interval(secs => $1)`
      const back = await pools.rw.query(
        `UPDATE jobs SET status = 'queued', started_at = NULL, heartbeat_at = NULL
          WHERE status = 'running' AND heartbeat_at < ${stale} AND attempts < $2`,
        [staleAfterSec, maxAttempts],
      )
      const dead = await pools.rw.query(
        `UPDATE jobs SET status = 'error', finished_at = now(),
                         error = 'worker が繰り返し停止しました'
          WHERE status = 'running' AND heartbeat_at < ${stale} AND attempts >= $2`,
        [staleAfterSec, maxAttempts],
      )
      return (back.rowCount ?? 0) + (dead.rowCount ?? 0)
    },
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: PASS (18 件)

- [ ] **Step 5: コミット**

```bash
git add api/lib/jobs.ts api/lib/jobs.test.ts
git commit -m "feat(api): ジョブの claim / heartbeat / キャンセル / stale 再投入を実装する"
```

---

### Task 3: 完了ジョブの保持

**Files:**
- Modify: `api/lib/jobs.ts`
- Modify: `api/lib/jobs.test.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 1, 2)
- Produces: `JobStore.pruneFinished(keepDays: number): Promise<number>`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/jobs.test.ts` に追記:

```typescript
describe('pruneFinished', () => {
  // 最新の done は結果ストアを兼ねるので消せない。
  it('同一対象の最新 done は古くても残す', async () => {
    const id = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', finished_at = now() - interval '30 days' WHERE id=$1`, [id])
    expect(await store.pruneFinished(7)).toBe(0)
    expect(await store.get(id)).not.toBeNull()
  })

  it('より新しい done がある古い行は消す', async () => {
    const old = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', finished_at = now() - interval '30 days' WHERE id=$1`, [old])
    const recent = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', finished_at = now() WHERE id=$1`, [recent])

    expect(await store.pruneFinished(7)).toBe(1)
    expect(await store.get(old)).toBeNull()
    expect(await store.get(recent)).not.toBeNull()
  })

  it('保持期間内の行は消さない', async () => {
    const a = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='done', finished_at = now() - interval '1 day' WHERE id=$1`, [a])
    const b = await store.enqueue('k', 'd', {})
    await pools.rw.query(`UPDATE jobs SET status='done', finished_at = now() WHERE id=$1`, [b])
    expect(await store.pruneFinished(7)).toBe(0)
  })

  it('error / canceled も対象 (新しい done があれば)', async () => {
    const bad = await store.enqueue('k', 'd', {})
    await pools.rw.query(
      `UPDATE jobs SET status='error', finished_at = now() - interval '30 days' WHERE id=$1`, [bad])
    const ok = await store.enqueue('k', 'd', {})
    await pools.rw.query(`UPDATE jobs SET status='done', finished_at = now() WHERE id=$1`, [ok])
    expect(await store.pruneFinished(7)).toBe(1)
    expect(await store.get(bad)).toBeNull()
  })

  it('running / queued は消さない', async () => {
    await store.enqueue('k', 'd', {})
    expect(await store.pruneFinished(0)).toBe(0)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: FAIL — `store.pruneFinished is not a function`

- [ ] **Step 3: 実装する**

`JobStore` に追加:

```typescript
  /** 完了ジョブの掃除。(kind, dedup_key) ごとの最新 done は結果ストアを
   *  兼ねるので残し、それより古い完了行だけを消す。戻り値は削除件数。 */
  pruneFinished(keepDays: number): Promise<number>
```

実装:

```typescript
    async pruneFinished(keepDays) {
      const r = await pools.rw.query(
        `DELETE FROM jobs j
          WHERE j.status IN ('done','error','canceled')
            AND j.finished_at < now() - make_interval(days => $1)
            AND EXISTS (
              SELECT 1 FROM jobs n
               WHERE n.kind = j.kind AND n.dedup_key = j.dedup_key
                 AND n.status = 'done' AND n.finished_at > j.finished_at
            )`,
        [keepDays],
      )
      return r.rowCount ?? 0
    },
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/jobs.test.ts`
Expected: PASS (23 件)

- [ ] **Step 5: コミット**

```bash
git add api/lib/jobs.ts api/lib/jobs.test.ts
git commit -m "feat(api): 完了ジョブの保持ルールを実装する"
```

---

### Task 4: ジョブランナー (ハンドラ登録・進捗の間引き・キャンセルの伝播)

**Files:**
- Create: `api/lib/job-runner.ts`
- Test: `api/lib/job-runner.test.ts`

**Interfaces:**
- Consumes: `JobStore`, `JobProgress` (Task 1-3)
- Produces:
  - `JobContext = { payload: unknown; signal: AbortSignal; setProgress(p: JobProgress): void }`
  - `JobHandler = (ctx: JobContext) => Promise<unknown>`
  - `createJobRunner(deps: { store: JobStore; handlers: Record<string, JobHandler>; now?: () => number; progressIntervalMs?: number; cancelCheckIntervalMs?: number }): { runOnce(): Promise<boolean> }`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/job-runner.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { createJobRunner, type JobHandler } from './job-runner.js'
import type { JobProgress, JobStore } from './jobs.js'

// store の fake。実 DB は jobs.test.ts で検証済みなので、ここは
// ランナーの制御フローだけを見る。
function fakeStore(job: { id: number; kind: string; payload: unknown } | null) {
  const calls = {
    finish: [] as Array<[number, unknown]>,
    fail: [] as Array<[number, string]>,
    heartbeat: [] as Array<[number, JobProgress | null]>,
  }
  let canceled = false
  const store = {
    claim: async () => job,
    heartbeat: async (id: number, p: JobProgress | null) => { calls.heartbeat.push([id, p]) },
    finish: async (id: number, r: unknown) => { calls.finish.push([id, r]) },
    fail: async (id: number, m: string) => { calls.fail.push([id, m]) },
    isCanceled: async () => canceled,
  } as unknown as JobStore
  return { store, calls, setCanceled: (v: boolean) => { canceled = v } }
}

describe('createJobRunner', () => {
  it('queued が無ければ false を返す', async () => {
    const { store } = fakeStore(null)
    const runner = createJobRunner({ store, handlers: {} })
    expect(await runner.runOnce()).toBe(false)
  })

  it('ハンドラの戻り値が finish に渡る', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: { a: 1 } })
    const handler: JobHandler = async ctx => ({ echoed: ctx.payload })
    const runner = createJobRunner({ store, handlers: { k: handler } })
    expect(await runner.runOnce()).toBe(true)
    expect(calls.finish).toEqual([[1, { echoed: { a: 1 } }]])
  })

  it('ハンドラが throw したら fail にメッセージが渡る', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: {} })
    const handler: JobHandler = async () => { throw new Error('S3 が落ちています') }
    const runner = createJobRunner({ store, handlers: { k: handler } })
    await runner.runOnce()
    expect(calls.fail[0][1]).toBe('S3 が落ちています')
  })

  it('未登録の kind は fail にする', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'unknown.kind', payload: {} })
    const runner = createJobRunner({ store, handlers: {} })
    await runner.runOnce()
    expect(calls.fail[0][1]).toContain('unknown.kind')
  })

  // ハンドラは呼び放題でよく、間引きは基盤側で行う。
  it('setProgress は指定間隔に間引かれる', async () => {
    const { store, calls } = fakeStore({ id: 1, kind: 'k', payload: {} })
    let t = 0
    const handler: JobHandler = async ctx => {
      ctx.setProgress({ kind: 'count', done: 1 })   // t=0: 書かれる
      t = 500
      ctx.setProgress({ kind: 'count', done: 2 })   // 間隔未満 → 捨てる
      t = 2500
      ctx.setProgress({ kind: 'count', done: 3 })   // 書かれる
      return null
    }
    const runner = createJobRunner({
      store, handlers: { k: handler }, now: () => t, progressIntervalMs: 2000,
    })
    await runner.runOnce()
    const written = calls.heartbeat.map(([, p]) => p)
    expect(written).toEqual([
      { kind: 'count', done: 1 },
      { kind: 'count', done: 3 },
    ])
  })

  it('canceled になったら signal が abort される', async () => {
    const { store, setCanceled } = fakeStore({ id: 1, kind: 'k', payload: {} })
    let aborted = false
    const handler: JobHandler = async ctx => {
      setCanceled(true)
      // キャンセル確認は setProgress のタイミングで走る
      ctx.setProgress({ kind: 'count', done: 1 })
      await new Promise(r => setTimeout(r, 10))
      aborted = ctx.signal.aborted
      return null
    }
    let t = 0
    const runner = createJobRunner({
      store, handlers: { k: handler }, now: () => (t += 10_000),
      progressIntervalMs: 0, cancelCheckIntervalMs: 0,
    })
    await runner.runOnce()
    expect(aborted).toBe(true)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/job-runner.test.ts`
Expected: FAIL — `Failed to resolve import "./job-runner.js"`

- [ ] **Step 3: 実装する**

`api/lib/job-runner.ts`:

```typescript
import type { JobProgress, JobStore } from './jobs.js'

// ジョブの実行ループ (spec: 2026-08-18-job-queue-design.md)。
// SQL は jobs.ts に閉じており、ここは「claim → ハンドラ → 結果保存」の
// 制御フローと、進捗の間引き・キャンセルの伝播だけを持つ。

export interface JobContext {
  payload: unknown
  /** canceled になったら abort される。長い処理はこれを見て抜ける。 */
  signal: AbortSignal
  /** 呼び放題。書き込みは progressIntervalMs に間引かれる。 */
  setProgress(p: JobProgress): void
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

export interface JobRunnerDeps {
  store: JobStore
  /** kind → handler。新しいジョブ種別はここに 1 行足す。 */
  handlers: Record<string, JobHandler>
  /** テスト用の時計。 */
  now?: () => number
  /** 進捗の書き込み間隔。既定 2 秒。 */
  progressIntervalMs?: number
  /** キャンセル確認の間隔。既定 2 秒。 */
  cancelCheckIntervalMs?: number
}

export function createJobRunner(deps: JobRunnerDeps): { runOnce(): Promise<boolean> } {
  const now = deps.now ?? (() => Date.now())
  const progressInterval = deps.progressIntervalMs ?? 2000
  const cancelInterval = deps.cancelCheckIntervalMs ?? 2000

  return {
    /** queued を 1 件処理する。処理したら true、無ければ false。 */
    async runOnce() {
      const job = await deps.store.claim()
      if (!job) return false

      const handler = deps.handlers[job.kind]
      if (!handler) {
        await deps.store.fail(job.id, `未登録のジョブ種別です: ${job.kind}`)
        return true
      }

      const ac = new AbortController()
      let lastProgressAt = -Infinity
      let lastCancelCheckAt = -Infinity

      const ctx: JobContext = {
        payload: job.payload,
        signal: ac.signal,
        setProgress(p) {
          const t = now()
          if (t - lastProgressAt >= progressInterval) {
            lastProgressAt = t
            // 進捗は補助情報。書けなくても処理は続ける。
            void deps.store.heartbeat(job.id, p).catch(() => {})
          }
          if (t - lastCancelCheckAt >= cancelInterval) {
            lastCancelCheckAt = t
            void deps.store.isCanceled(job.id)
              .then(c => { if (c) ac.abort() })
              .catch(() => {})
          }
        },
      }

      try {
        const result = await handler(ctx)
        // キャンセルされていたら finish しない (status は既に canceled)。
        if (!ac.signal.aborted) await deps.store.finish(job.id, result ?? null)
      } catch (e) {
        if (!ac.signal.aborted) await deps.store.fail(job.id, (e as Error).message)
      }
      return true
    },
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/job-runner.test.ts`
Expected: PASS (6 件)

- [ ] **Step 5: コミット**

```bash
git add api/lib/job-runner.ts api/lib/job-runner.test.ts
git commit -m "feat(api): ジョブランナーとハンドラ登録の仕組みを追加する"
```

---

### Task 5: 走査の集計ロジック (純関数)

**Files:**
- Create: `api/lib/scan.ts`
- Test: `api/lib/scan.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `ScanEntry = { key: string; size: number }`
  - `ScanResult = { objectCount: number; totalBytes: number; children: Array<{ name: string; objectCount: number; totalBytes: number }>; extensions: Array<{ ext: string; objectCount: number; totalBytes: number }>; partial: boolean }`
  - `createScanAccumulator(prefix: string): { add(e: ScanEntry): void; count(): number; result(partial: boolean): ScanResult }`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/scan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createScanAccumulator } from './scan.js'

const add = (acc: ReturnType<typeof createScanAccumulator>, key: string, size: number) =>
  acc.add({ key, size })

describe('createScanAccumulator', () => {
  it('件数と合計サイズを数える', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/a.tar', 100)
    add(acc, 'd/b.tar', 250)
    const r = acc.result(false)
    expect(r.objectCount).toBe(2)
    expect(r.totalBytes).toBe(350)
  })

  // 深い階層のキーも、直下のディレクトリ名に合算する。
  it('直下のサブディレクトリ別に集計する', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/x/1.tar', 10)
    add(acc, 'd/x/deep/2.tar', 20)
    add(acc, 'd/y/3.tar', 5)
    add(acc, 'd/top.tar', 1)
    const r = acc.result(false)
    expect(r.children).toEqual([
      { name: 'x/', objectCount: 2, totalBytes: 30 },
      { name: 'y/', objectCount: 1, totalBytes: 5 },
    ])
  })

  it('children はサイズ降順', () => {
    const acc = createScanAccumulator('')
    add(acc, 'small/a', 1)
    add(acc, 'big/a', 1000)
    expect(acc.result(false).children.map(c => c.name)).toEqual(['big/', 'small/'])
  })

  it('拡張子別に集計する', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/a.tar', 100)
    add(acc, 'd/b.tar', 100)
    add(acc, 'd/c.json', 5)
    const r = acc.result(false)
    expect(r.extensions).toEqual([
      { ext: '.tar', objectCount: 2, totalBytes: 200 },
      { ext: '.json', objectCount: 1, totalBytes: 5 },
    ])
  })

  // .tar.gz は「最後のドット以降」だと .gz になってしまう。
  it('二重拡張子は既知の組み合わせをまとめて扱う', () => {
    const acc = createScanAccumulator('')
    add(acc, 'a.tar.gz', 10)
    add(acc, 'b.tar.xz', 20)
    expect(acc.result(false).extensions.map(e => e.ext)).toEqual(['.tar.xz', '.tar.gz'])
  })

  it('拡張子が無いファイルは (なし) にまとめる', () => {
    const acc = createScanAccumulator('')
    add(acc, 'README', 1)
    expect(acc.result(false).extensions[0].ext).toBe('(なし)')
  })

  it('prefix 自身を表す 0 バイトのキーは数えない', () => {
    const acc = createScanAccumulator('d/')
    add(acc, 'd/', 0)
    add(acc, 'd/a.tar', 10)
    expect(acc.result(false).objectCount).toBe(1)
  })

  it('count() は現在までの件数を返す (進捗表示用)', () => {
    const acc = createScanAccumulator('')
    add(acc, 'a', 1)
    add(acc, 'b', 1)
    expect(acc.count()).toBe(2)
  })

  it('partial をそのまま結果に載せる', () => {
    expect(createScanAccumulator('').result(true).partial).toBe(true)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/scan.test.ts`
Expected: FAIL — `Failed to resolve import "./scan.js"`

- [ ] **Step 3: 実装する**

`api/lib/scan.ts`:

```typescript
// ディレクトリ走査の集計 (spec: 2026-08-18-directory-scan-design.md)。
// S3 を知らない純ロジック。ページングは scan-handler.ts が持つ。

export interface ScanEntry {
  key: string
  size: number
}

export interface ScanResult {
  objectCount: number
  totalBytes: number
  /** 直下のサブディレクトリ別の内訳。サイズ降順、最大 50 件。 */
  children: Array<{ name: string; objectCount: number; totalBytes: number }>
  /** 拡張子別の内訳。サイズ降順、最大 10 件。 */
  extensions: Array<{ ext: string; objectCount: number; totalBytes: number }>
  /** 途中で S3 エラーが出たが、そこまでの集計を返しているか。 */
  partial: boolean
}

const CHILDREN_LIMIT = 50
const EXTENSIONS_LIMIT = 10

// 最後のドット以降を取ると .tar.gz が .gz になってしまうので、
// よく使う二重拡張子だけ先に判定する。
const DOUBLE_EXTS = ['.tar.gz', '.tar.xz', '.tar.bz2', '.tar.zst']

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  for (const d of DOUBLE_EXTS) {
    if (lower.endsWith(d)) return d
  }
  const dot = lower.lastIndexOf('.')
  const slash = lower.lastIndexOf('/')
  if (dot <= slash + 1) return '(なし)'
  return lower.slice(dot)
}

interface Bucket {
  objectCount: number
  totalBytes: number
}

function toSorted(
  m: Map<string, Bucket>,
  limit: number,
  nameKey: 'name' | 'ext',
): Array<Record<string, unknown>> {
  return [...m.entries()]
    .sort((a, b) => b[1].totalBytes - a[1].totalBytes)
    .slice(0, limit)
    .map(([k, v]) => ({ [nameKey]: k, objectCount: v.objectCount, totalBytes: v.totalBytes }))
}

function bump(m: Map<string, Bucket>, key: string, size: number): void {
  const cur = m.get(key)
  if (cur) {
    cur.objectCount += 1
    cur.totalBytes += size
  } else {
    m.set(key, { objectCount: 1, totalBytes: size })
  }
}

export function createScanAccumulator(prefix: string) {
  let objectCount = 0
  let totalBytes = 0
  const children = new Map<string, Bucket>()
  const extensions = new Map<string, Bucket>()

  return {
    add(e: ScanEntry): void {
      // S3 互換実装が返す「そのディレクトリ自身」の 0 バイト placeholder は数えない。
      if (e.key === prefix) return

      objectCount += 1
      totalBytes += e.size

      const rest = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key
      const slash = rest.indexOf('/')
      if (slash >= 0) bump(children, rest.slice(0, slash + 1), e.size)

      bump(extensions, extensionOf(rest), e.size)
    },

    count(): number {
      return objectCount
    },

    result(partial: boolean): ScanResult {
      return {
        objectCount,
        totalBytes,
        children: toSorted(children, CHILDREN_LIMIT, 'name') as ScanResult['children'],
        extensions: toSorted(extensions, EXTENSIONS_LIMIT, 'ext') as ScanResult['extensions'],
        partial,
      }
    },
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/scan.test.ts`
Expected: PASS (9 件)

- [ ] **Step 5: コミット**

```bash
git add api/lib/scan.ts api/lib/scan.test.ts
git commit -m "feat(api): 走査の集計ロジックを追加する"
```

---

### Task 6: 走査ハンドラ (S3 ページング)

**Files:**
- Create: `api/lib/scan-handler.ts`
- Test: `api/lib/scan-handler.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `JobHandler` (Task 4), `createScanAccumulator`, `ScanResult` (Task 5), `GetStorage` from `api/routes/_connId.js`, `ConnectionConfig` from `api/storage.js`
- Produces: `createScanHandler(deps: { getStorage: GetStorage; getConnectionConfig: (connId: string) => Promise<ConnectionConfig> }): JobHandler`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/scan-handler.test.ts`:

```typescript
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { createScanHandler } from './scan-handler.js'
import type { JobContext } from './job-runner.js'
import type { ScanResult } from './scan.js'

const storageMock = mockClient(S3Client)
const storage = new S3Client({})
const deps = {
  getStorage: async () => storage,
  getConnectionConfig: async () => ({ listObjectsVersion: 'v2' as const, capabilities: {} as never }),
}

function ctx(payload: unknown, signal = new AbortController().signal): JobContext {
  return { payload, signal, setProgress: () => {} }
}

beforeEach(() => storageMock.reset())

describe('createScanHandler', () => {
  it('複数ページを集計する', async () => {
    storageMock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'd/a.tar', Size: 100 }],
        IsTruncated: true, NextContinuationToken: 'tok',
      })
      .resolvesOnce({
        Contents: [{ Key: 'd/b.tar', Size: 200 }], IsTruncated: false,
      })

    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
    expect(r.objectCount).toBe(2)
    expect(r.totalBytes).toBe(300)
    expect(r.partial).toBe(false)
    expect(storageMock.calls()).toHaveLength(2)
  })

  it('Delimiter を送らない (フラット列挙)', async () => {
    storageMock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false })
    const handler = createScanHandler(deps)
    await handler(ctx({ connId: 'c1', bucket: 'b', prefix: '' }))
    const input = storageMock.calls()[0].args[0].input as { Delimiter?: string; MaxKeys?: number }
    expect(input.Delimiter).toBeUndefined()
    expect(input.MaxKeys).toBe(1000)
  })

  // 数十万キー数えた後に 1 ページ失敗して全部捨てるのは損。
  it('途中で S3 が失敗したら partial で返す', async () => {
    storageMock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'd/a.tar', Size: 100 }],
        IsTruncated: true, NextContinuationToken: 'tok',
      })
      .rejectsOnce(new Error('boom'))

    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' })) as ScanResult
    expect(r.objectCount).toBe(1)
    expect(r.partial).toBe(true)
  })

  it('signal が abort されたらページングを止める', async () => {
    const ac = new AbortController()
    storageMock.on(ListObjectsV2Command).callsFake(() => {
      ac.abort()
      return { Contents: [{ Key: 'd/a.tar', Size: 1 }], IsTruncated: true, NextContinuationToken: 'tok' }
    })
    const handler = createScanHandler(deps)
    const r = await handler(ctx({ connId: 'c1', bucket: 'b', prefix: 'd/' }, ac.signal)) as ScanResult
    expect(storageMock.calls()).toHaveLength(1)
    expect(r.objectCount).toBe(1)
  })

  it('payload が不正なら throw する', async () => {
    const handler = createScanHandler(deps)
    await expect(handler(ctx({ connId: 'c1' }))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/scan-handler.test.ts`
Expected: FAIL — `Failed to resolve import "./scan-handler.js"`

- [ ] **Step 3: 実装する**

`api/lib/scan-handler.ts`:

```typescript
import { ListObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { z } from 'zod'
import type { GetStorage } from '../routes/_connId.js'
import type { ConnectionConfig } from '../storage.js'
import type { JobContext, JobHandler } from './job-runner.js'
import { createScanAccumulator } from './scan.js'

// storage.scan ハンドラ (spec: 2026-08-18-directory-scan-design.md)。
//
// Delimiter は付けない。区切り付きは CommonPrefixes の計算が重く、mdx の
// dataset バケットでは prefix に関係なく 28〜35 秒かかる。付けなければ
// 0.095 秒 / ページで、547,259 キーでも約 223 秒 (実測)。
//
// MaxKeys は 1000。一覧の 100 と違い、ページ数を減らすのが目的。

const Payload = z.object({
  connId: z.string().min(1),
  bucket: z.string().min(1),
  prefix: z.string(),
})

const PAGE_SIZE = 1000

export interface ScanHandlerDeps {
  getStorage: GetStorage
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
}

export function createScanHandler(deps: ScanHandlerDeps): JobHandler {
  return async (ctx: JobContext) => {
    const { connId, bucket, prefix } = Payload.parse(ctx.payload)
    const storage = await deps.getStorage(connId)
    const config = await deps.getConnectionConfig(connId)
    const useV1 = config.listObjectsVersion === 'v1'

    const acc = createScanAccumulator(prefix)
    let cursor: string | undefined
    let partial = false

    for (;;) {
      if (ctx.signal.aborted) break

      let contents: Array<{ Key?: string; Size?: number }>
      let next: string | undefined
      try {
        if (useV1) {
          const out = await storage.send(new ListObjectsCommand({
            Bucket: bucket, Prefix: prefix, Marker: cursor, MaxKeys: PAGE_SIZE,
          }))
          contents = out.Contents ?? []
          // V1 は Delimiter 無しだと NextMarker を返さないことがあるので、
          // 最後のキーで marker フォールバックする (s3cmd と同じ手法)。
          next = out.IsTruncated
            ? out.NextMarker ?? contents[contents.length - 1]?.Key
            : undefined
        } else {
          const out = await storage.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: PAGE_SIZE,
          }))
          contents = out.Contents ?? []
          next = out.IsTruncated ? out.NextContinuationToken : undefined
        }
      } catch (e) {
        // ここまでの集計は返す。数十万キー数えた後に 1 ページの失敗で
        // 全部捨てるのは損なので。
        console.error(JSON.stringify({
          ev: 'storage.scan.page_failed', connId, bucket, prefix,
          scanned: acc.count(), error: (e as Error).message,
        }))
        partial = true
        break
      }

      for (const o of contents) {
        if (o.Key) acc.add({ key: o.Key, size: o.Size ?? 0 })
      }
      ctx.setProgress({ kind: 'count', done: acc.count(), label: '件を走査' })

      if (!next) break
      cursor = next
    }

    return acc.result(partial)
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/scan-handler.test.ts`
Expected: PASS (5 件)

- [ ] **Step 5: コミット**

```bash
git add api/lib/scan-handler.ts api/lib/scan-handler.test.ts
git commit -m "feat(api): 走査ハンドラ (S3 ページング) を追加する"
```

---

### Task 7: バケット設定

**Files:**
- Create: `db/migrations/018_bucket_settings.sql`
- Create: `api/lib/bucket-settings.ts`
- Test: `api/lib/bucket-settings.test.ts`

**Interfaces:**
- Consumes: `Pools`
- Produces:
  - `BucketSettings = { scanEnabled: boolean; listCacheTtlSec: number }`
  - `createBucketSettings(pools: Pools): { get(connId: string, bucket: string): Promise<BucketSettings>; set(connId: string, bucket: string, key: string, value: string): Promise<void> }`
  - `DEFAULT_BUCKET_SETTINGS: BucketSettings`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/bucket-settings.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createBucketSettings, DEFAULT_BUCKET_SETTINGS } from './bucket-settings.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const settings = createBucketSettings(pools)
const CONN = 'testconn01'

beforeEach(async () => {
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked)
     VALUES ($1, $1, 'https://s3.example.com/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…0000')`,
    [CONN],
  )
})
afterAll(() => closePools(pools))

describe('createBucketSettings', () => {
  it('行が無ければ既定値', async () => {
    expect(await settings.get(CONN, 'b1')).toEqual(DEFAULT_BUCKET_SETTINGS)
    expect(DEFAULT_BUCKET_SETTINGS).toEqual({ scanEnabled: true, listCacheTtlSec: 86400 })
  })

  it('scan_enabled=false が反映される', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    expect((await settings.get(CONN, 'b1')).scanEnabled).toBe(false)
  })

  it('バケットごとに独立している', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    expect((await settings.get(CONN, 'b2')).scanEnabled).toBe(true)
  })

  it('list_cache_ttl_sec が反映される', async () => {
    await settings.set(CONN, 'b1', 'list_cache_ttl_sec', '300')
    expect((await settings.get(CONN, 'b1')).listCacheTtlSec).toBe(300)
  })

  it('壊れた値は既定値に倒す', async () => {
    await settings.set(CONN, 'b1', 'list_cache_ttl_sec', 'いいかんじ')
    expect((await settings.get(CONN, 'b1')).listCacheTtlSec).toBe(86400)
  })

  it('set は UPSERT (同じ key を二度書ける)', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    await settings.set(CONN, 'b1', 'scan_enabled', 'true')
    expect((await settings.get(CONN, 'b1')).scanEnabled).toBe(true)
  })

  it('接続を消すと設定も消える (CASCADE)', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    await pools.rw.query('DELETE FROM storage_connections WHERE id=$1', [CONN])
    const n = await pools.rw.query('SELECT count(*)::int AS c FROM bucket_settings')
    expect(n.rows[0].c).toBe(0)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/bucket-settings.test.ts`
Expected: FAIL — `Failed to resolve import "./bucket-settings.js"`

- [ ] **Step 3: マイグレーションを書いて dev DB に流す**

`db/migrations/018_bucket_settings.sql`:

```sql
-- バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
-- 設定は app_settings (全体) と connection_settings (接続ごと) があり、
-- バケット単位だけが無かった。connection_settings と同じ key/value 形式。
CREATE TABLE IF NOT EXISTS bucket_settings (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, key),
  CHECK (length(key) BETWEEN 1 AND 64)
);

-- README/Favorites と同じく LAN 共有・認証なしの前提。編集者記録は持たない。
ALTER TABLE bucket_settings OWNER TO dashboard_rw;
GRANT SELECT ON bucket_settings TO dashboard_ro;
```

```bash
for db in dashboard dashboard_test; do
  docker compose -f compose.dev.yaml exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d $db -f /migrations/018_bucket_settings.sql
done
```

- [ ] **Step 4: 実装する**

`api/lib/bucket-settings.ts`:

```typescript
import type { Pools } from '../db.js'

// バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
// connection_settings と同じ key/value 形式。未設定なら既定値に倒す。

export interface BucketSettings {
  /** false なら走査を投入できない (API も 403)。巨大バケットのガード。 */
  scanEnabled: boolean
  /** 一覧キャッシュの TTL。更新の激しいバケットは短く。 */
  listCacheTtlSec: number
}

export const DEFAULT_BUCKET_SETTINGS: BucketSettings = {
  scanEnabled: true,
  listCacheTtlSec: 86400,
}

export function createBucketSettings(pools: Pools) {
  return {
    async get(connId: string, bucket: string): Promise<BucketSettings> {
      const r = await pools.ro.query<{ key: string; value: string }>(
        'SELECT key, value FROM bucket_settings WHERE connection_id = $1 AND bucket = $2',
        [connId, bucket],
      )
      const m = new Map(r.rows.map(x => [x.key, x.value]))

      const ttlRaw = Number(m.get('list_cache_ttl_sec'))
      return {
        // 'false' だけを無効とみなす (connection_settings と同じ約束)。
        scanEnabled: m.get('scan_enabled') !== 'false',
        listCacheTtlSec: Number.isFinite(ttlRaw) && ttlRaw > 0
          ? ttlRaw
          : DEFAULT_BUCKET_SETTINGS.listCacheTtlSec,
      }
    },

    async set(connId: string, bucket: string, key: string, value: string): Promise<void> {
      await pools.rw.query(
        `INSERT INTO bucket_settings (connection_id, bucket, key, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connection_id, bucket, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [connId, bucket, key, value],
      )
    },
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd api && npx vitest run lib/bucket-settings.test.ts`
Expected: PASS (7 件)

- [ ] **Step 6: コミット**

```bash
git add db/migrations/018_bucket_settings.sql api/lib/bucket-settings.ts api/lib/bucket-settings.test.ts
git commit -m "feat(api): バケット単位の設定を追加する"
```

---

### Task 8: API ルート

**Files:**
- Create: `api/routes/jobs.ts`
- Create: `api/routes/storage-scan.ts`
- Test: `api/routes/storage-scan.test.ts`
- Modify: `api/internal.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 1-3), `createBucketSettings` (Task 7)
- Produces:
  - `mountJobRoutes(app: Hono, deps: { store: JobStore }): void`
  - `mountStorageScanRoutes(app: Hono, deps: { store: JobStore; bucketSettings: { get(connId: string, bucket: string): Promise<BucketSettings> } }): void`
  - `SCAN_KIND = 'storage.scan'`
  - `scanDedupKey(connId: string, bucket: string, prefix: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`api/routes/storage-scan.test.ts`:

```typescript
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountStorageScanRoutes, scanDedupKey, SCAN_KIND } from './storage-scan.js'
import type { JobStore } from '../lib/jobs.js'
import { DEFAULT_BUCKET_SETTINGS } from '../lib/bucket-settings.js'

let enqueued: Array<[string, string, unknown]> = []
let scanEnabled = true

const store = {
  enqueue: async (kind: string, dedupKey: string, payload: unknown) => {
    enqueued.push([kind, dedupKey, payload])
    return 7
  },
} as unknown as JobStore

const app = new Hono()
mountStorageScanRoutes(app, {
  store,
  bucketSettings: { get: async () => ({ ...DEFAULT_BUCKET_SETTINGS, scanEnabled }) },
})

beforeEach(() => { enqueued = []; scanEnabled = true })

describe('POST /storage/:connId/scan', () => {
  it('ジョブを投入して id を返す', async () => {
    const res = await app.request('/storage/c1/scan?bucket=b1&prefix=p/', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobId: 7 })
    expect(enqueued).toEqual([[SCAN_KIND, scanDedupKey('c1', 'b1', 'p/'), {
      connId: 'c1', bucket: 'b1', prefix: 'p/',
    }]])
  })

  it('prefix 省略はバケット root として扱う', async () => {
    await app.request('/storage/c1/scan?bucket=b1', { method: 'POST' })
    expect(enqueued[0][2]).toEqual({ connId: 'c1', bucket: 'b1', prefix: '' })
  })

  it('bucket が無ければ 400', async () => {
    const res = await app.request('/storage/c1/scan', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  // UI がボタンを隠していても共有 URL を直に叩けるので API 側でも止める。
  it('scan_enabled=false なら 403 で投入しない', async () => {
    scanEnabled = false
    const res = await app.request('/storage/c1/scan?bucket=b1&prefix=p/', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(enqueued).toHaveLength(0)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run routes/storage-scan.test.ts`
Expected: FAIL — `Failed to resolve import "./storage-scan.js"`

- [ ] **Step 3: 走査ルートを書く**

`api/routes/storage-scan.ts`:

```typescript
import type { Hono } from 'hono'
import type { BucketSettings } from '../lib/bucket-settings.js'
import type { JobStore } from '../lib/jobs.js'

// 走査ジョブの投入 (spec: 2026-08-18-directory-scan-design.md)。
// 汎用の POST /jobs は作らない。任意の kind と payload を外から投げられる口は
// 権限の観点でも入力検証の観点でも面倒が多いので、種別ごとに専用の口を持つ。

export const SCAN_KIND = 'storage.scan'

/** 実行中の同一ディレクトリを 1 本に合流させるためのキー。 */
export function scanDedupKey(connId: string, bucket: string, prefix: string): string {
  return `${connId}\n${bucket}\n${prefix}`
}

export interface StorageScanDeps {
  store: JobStore
  bucketSettings: { get(connId: string, bucket: string): Promise<BucketSettings> }
}

export function mountStorageScanRoutes(app: Hono, deps: StorageScanDeps): void {
  app.post('/storage/:connId/scan', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''

    const settings = await deps.bucketSettings.get(connId, bucket)
    if (!settings.scanEnabled) {
      return c.json({ error: `このバケットでは走査が無効になっています: ${bucket}` }, 403)
    }

    const jobId = await deps.store.enqueue(
      SCAN_KIND,
      scanDedupKey(connId, bucket, prefix),
      { connId, bucket, prefix },
    )
    return c.json({ jobId })
  })
}
```

- [ ] **Step 4: ジョブルートを書く**

`api/routes/jobs.ts`:

```typescript
import type { Hono } from 'hono'
import type { JobStore } from '../lib/jobs.js'

// ジョブの参照とキャンセル (spec: 2026-08-18-job-queue-design.md)。
// 投入は種別ごとのエンドポイントが行うので、ここには作らない。

export interface JobRoutesDeps {
  store: JobStore
}

export function mountJobRoutes(app: Hono, deps: JobRoutesDeps): void {
  app.get('/jobs/latest', async c => {
    const kind = c.req.query('kind')
    const dedupKey = c.req.query('dedupKey')
    if (!kind || !dedupKey) return c.json({ error: 'kind and dedupKey are required' }, 400)
    const job = await deps.store.latestDone(kind, dedupKey)
    return job ? c.json(job) : c.json({ error: 'not found' }, 404)
  })

  app.get('/jobs/:id', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    const job = await deps.store.get(id)
    return job ? c.json(job) : c.json({ error: 'not found' }, 404)
  })

  app.post('/jobs/:id/cancel', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    await deps.store.cancel(id)
    return c.json({ ok: true })
  })
}
```

**注意**: `/jobs/latest` を `/jobs/:id` より**前**に登録すること。Hono は登録順に照合するので、逆にすると `latest` が `:id` に食われる。

- [ ] **Step 5: internal.ts に配線する**

```typescript
import { createJobStore } from './lib/jobs.js'
import { createBucketSettings } from './lib/bucket-settings.js'
import { mountJobRoutes } from './routes/jobs.js'
import { mountStorageScanRoutes } from './routes/storage-scan.js'
```

`const responseCache = createResponseCache(pools.rw)` の下に:

```typescript
const jobStore = createJobStore(pools)
const bucketSettings = createBucketSettings(pools)
```

ルート登録の並びに追加:

```typescript
mountJobRoutes(api, { store: jobStore })
mountStorageScanRoutes(api, { store: jobStore, bucketSettings })
```

- [ ] **Step 6: テストと型検査**

Run: `cd api && npx tsc --noEmit && npx vitest run routes/storage-scan.test.ts`
Expected: 型エラー無し、PASS (4 件)

- [ ] **Step 7: コミット**

```bash
git add api/routes/jobs.ts api/routes/storage-scan.ts api/routes/storage-scan.test.ts api/internal.ts
git commit -m "feat(api): 走査の投入とジョブ参照の API を追加する"
```

---

### Task 9: worker への組み込み

**Files:**
- Modify: `api/worker.ts`

**Interfaces:**
- Consumes: `createJobStore` (Task 1-3), `createJobRunner` (Task 4), `createScanHandler` (Task 6), `SCAN_KIND` (Task 8)
- Produces: なし

- [ ] **Step 1: ジョブループを足す**

`api/worker.ts` の import に追加:

```typescript
import { createJobStore } from './lib/jobs.js'
import { createJobRunner } from './lib/job-runner.js'
import { createScanHandler } from './lib/scan-handler.js'
import { SCAN_KIND } from './routes/storage-scan.js'
```

`const server = serve({...})` の**前**に:

```typescript
const jobStore = createJobStore(pools)
const jobRunner = createJobRunner({
  store: jobStore,
  // 新しいジョブ種別はここに 1 行足す。
  handlers: {
    [SCAN_KIND]: createScanHandler({
      getStorage: storageFactory.getStorage,
      getConnectionConfig: storageFactory.getConnectionConfig,
    }),
  },
})
```

既存の `cleanupTimer` の下に:

```typescript
// ── ジョブループ ──
// queued が無ければ 2 秒待つだけなので DB への負荷は無視できる。
// 起動直後に DB が未到達でも worker を殺さない (旧実装の方針を踏襲)。
let jobLoopStopping = false
async function jobLoop(): Promise<void> {
  for (;;) {
    if (jobLoopStopping) return
    try {
      const ran = await jobRunner.runOnce()
      if (!ran) await new Promise(r => setTimeout(r, 2000))
    } catch (e) {
      console.error('job loop error', e)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
void jobLoop()

// worker が落ちたまま running で残ったジョブを拾い直す。
// attempts >= 3 のものは error に落として無限再投入を防ぐ。
const staleTimer = setInterval(() => {
  jobStore.requeueStale(120, 3).catch(e => console.error('requeueStale error', e))
}, 60_000)
staleTimer.unref()

// 完了ジョブの掃除。最新の done は結果ストアを兼ねるので残る。
const pruneTimer = setInterval(() => {
  jobStore.pruneFinished(7).catch(e => console.error('pruneFinished error', e))
}, 24 * 60 * 60 * 1000)
pruneTimer.unref()
void jobStore.pruneFinished(7).catch(() => {})
```

`shutdown` の中、`server.close` の**前**に:

```typescript
  jobLoopStopping = true
```

- [ ] **Step 2: 型検査**

Run: `cd api && npx tsc --noEmit`
Expected: 型エラー無し

- [ ] **Step 3: dev で end-to-end に動かす**

```bash
docker compose -f compose.dev.yaml restart api-internal media-worker
sleep 5
# 接続 id は環境に合わせる (GET /api/internal/connections で確認)
curl -s -X POST "http://localhost:5173/api/internal/storage/<connId>/scan?bucket=<bucket>" | tee /tmp/job.json
JOB=$(node -e "console.log(require('/tmp/job.json').jobId)")
sleep 3
curl -s "http://localhost:5173/api/internal/jobs/$JOB"
```
Expected: `status` が `queued` → `running` → `done` と進み、`result` に `objectCount` / `totalBytes` が入る

- [ ] **Step 4: コミット**

```bash
git add api/worker.ts
git commit -m "feat(api): worker にジョブループを戻し、走査ハンドラを登録する"
```

---

### Task 10: フロント (API クライアントとモーダル)

**Files:**
- Modify: `front/lib/api/types.ts`
- Modify: `front/lib/api/client.ts`
- Create: `front/components/storage/ScanModal.tsx`
- Test: `front/components/storage/ScanModal.test.tsx`
- Modify: `front/components/StorageBrowser.tsx`

**Interfaces:**
- Consumes: `POST /storage/:connId/scan`, `GET /jobs/:id`, `GET /jobs/latest`, `POST /jobs/:id/cancel` (Task 8)
- Produces:
  - `api.startScan(connId, bucket, prefix): Promise<{ jobId: number }>`
  - `api.getJob(id): Promise<Job>`
  - `api.latestScan(connId, bucket, prefix): Promise<Job | null>`
  - `api.cancelJob(id): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/ScanModal.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScanModal } from './ScanModal'
import { api } from '../../lib/api/client'

vi.mock('../../lib/api/client', () => ({
  api: {
    startScan: vi.fn(),
    getJob: vi.fn(),
    latestScan: vi.fn(),
    cancelJob: vi.fn(),
  },
}))

const RESULT = {
  objectCount: 1234, totalBytes: 5_000_000_000,
  children: [{ name: 'sub/', objectCount: 1000, totalBytes: 4_000_000_000 }],
  extensions: [{ ext: '.tar', objectCount: 1234, totalBytes: 5_000_000_000 }],
  partial: false,
}

beforeEach(() => vi.clearAllMocks())

describe('ScanModal', () => {
  it('保存済みの結果があれば開いた時点で出す', async () => {
    ;(api.latestScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: '2026-08-18T07:00:00.000Z',
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/1,234/)).toBeInTheDocument()
  })

  it('未走査なら実行を促す', async () => {
    ;(api.latestScan as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/まだ走査していません/)).toBeInTheDocument()
  })

  it('実行すると投入し、done になったら結果を出す', async () => {
    ;(api.latestScan as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(api.startScan as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 9 })
    ;(api.getJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 9, status: 'running', progress: { kind: 'count', done: 500 } })
      .mockResolvedValue({ id: 9, status: 'done', result: RESULT, finishedAt: null })

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '走査する' }))

    expect(await screen.findByText(/500/)).toBeInTheDocument()      // 進捗
    await waitFor(() => expect(screen.getByText(/1,234/)).toBeInTheDocument(), { timeout: 3000 })
  })

  it('走査中はキャンセルできる', async () => {
    ;(api.latestScan as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(api.startScan as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 9 })
    ;(api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 9, status: 'running', progress: { kind: 'count', done: 1 },
    })

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '走査する' }))
    await user.click(await screen.findByRole('button', { name: '中止' }))
    expect(api.cancelJob).toHaveBeenCalledWith(9)
  })

  it('partial なら断りを出す', async () => {
    ;(api.latestScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1, status: 'done', result: { ...RESULT, partial: true }, finishedAt: null,
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/集計は途中まで/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd front && npx vitest run components/storage/ScanModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./ScanModal"`

- [ ] **Step 3: 型と API クライアントを足す**

`front/lib/api/types.ts` に追加:

```typescript
export const ScanResult = z.object({
  objectCount: z.number(),
  totalBytes: z.number(),
  children: z.array(z.object({
    name: z.string(), objectCount: z.number(), totalBytes: z.number(),
  })),
  extensions: z.array(z.object({
    ext: z.string(), objectCount: z.number(), totalBytes: z.number(),
  })),
  partial: z.boolean(),
})

export const JobProgress = z.union([
  z.object({ kind: z.literal('count'), done: z.number(), label: z.string().optional() }),
  z.object({ kind: z.literal('ratio'), done: z.number(), total: z.number(), label: z.string().optional() }),
])

export const Job = z.object({
  id: z.number(),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'done', 'error', 'canceled']),
  progress: JobProgress.nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const StartScanOk = z.object({ jobId: z.number() })
```

`front/lib/api/client.ts` に追加 (`Job`, `StartScanOk` を import):

```typescript
  // ── 走査ジョブ ──
  // 走査は重いのでキャッシュ層は通さない。状態はサーバーが持つ。
  startScan: (connId: string, bucket: string, prefix: string) =>
    mutateJson(
      buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/scan`, { bucket, prefix }),
      { method: 'POST' },
      StartScanOk,
    ),

  getJob: (id: number) => getJson(`${API_BASE}/jobs/${id}`, Job),

  /** 最後に成功した走査結果。無ければ null。 */
  latestScan: async (connId: string, bucket: string, prefix: string) => {
    const dedupKey = `${connId}\n${bucket}\n${prefix}`
    const res = await fetch(
      buildUrl(`${API_BASE}/jobs/latest`, { kind: 'storage.scan', dedupKey }),
      { headers: { Accept: 'application/json' } },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(res.statusText)
    return Job.parse(await res.json())
  },

  cancelJob: async (id: number): Promise<void> => {
    await mutateJson(`${API_BASE}/jobs/${id}/cancel`, { method: 'POST' }, null)
  },
```

- [ ] **Step 4: モーダルを書く**

`front/components/storage/ScanModal.tsx`:

```typescript
// ディレクトリ配下のオブジェクト数・サイズを見るモーダル
// (spec: 2026-08-18-directory-scan-design.md)。
//
// 走査はキューで走るので、モーダルを閉じても止まらない。閉じて後から見に来れば
// 結果がある。止めたいときは「中止」を押す。
//
// 進捗にパーセンテージは出ない。S3 には件数を返す API が無く、初回の走査では
// 分母が原理的に出せないため。「123,456 件を走査中」と実数だけを出す。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api/client'
import { ScanResult as ScanResultSchema } from '../../lib/api/types'
import { fmtSize } from '../../lib/format'
import type { z } from 'zod'

type ScanResult = z.infer<typeof ScanResultSchema>

interface Props {
  connId: string
  bucket: string
  prefix: string
  onClose: () => void
}

const POLL_MS = 1000

export function ScanModal({ connId, bucket, prefix, onClose }: Props) {
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scannedAt, setScannedAt] = useState<string | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'error' | 'canceled'>('idle')
  const [scanned, setScanned] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const timer = useRef<number | null>(null)

  // 開いた直後に保存済みの結果を引く。
  useEffect(() => {
    let cancelled = false
    api.latestScan(connId, bucket, prefix)
      .then(job => {
        if (cancelled || !job) return
        setResult(ScanResultSchema.parse(job.result))
        setScannedAt(job.finishedAt)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [connId, bucket, prefix])

  // 実行中だけポーリングする。終端状態で止める。
  useEffect(() => {
    if (jobId === null || status !== 'running') return
    const tick = (): void => {
      api.getJob(jobId).then(job => {
        if (job.progress && job.progress.kind === 'count') setScanned(job.progress.done)
        if (job.status === 'done') {
          setResult(ScanResultSchema.parse(job.result))
          setScannedAt(job.finishedAt)
          setStatus('idle')
        } else if (job.status === 'error') {
          setError(job.error ?? '走査に失敗しました')
          setStatus('error')
        } else if (job.status === 'canceled') {
          setStatus('canceled')
        }
      }).catch(() => {})
    }
    timer.current = window.setInterval(tick, POLL_MS)
    tick()
    return () => { if (timer.current != null) window.clearInterval(timer.current) }
  }, [jobId, status])

  const start = useCallback(() => {
    setError(null)
    setScanned(0)
    setStatus('running')
    api.startScan(connId, bucket, prefix)
      .then(r => setJobId(r.jobId))
      .catch((e: Error) => { setError(e.message); setStatus('error') })
  }, [connId, bucket, prefix])

  const cancel = useCallback(() => {
    if (jobId !== null) api.cancelJob(jobId).catch(() => {})
  }, [jobId])

  const label = prefix || '(バケット直下)'

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="配下の集計">
      <header className="flex items-baseline gap-3">
        <h2 className="m-0 text-[15px]">配下の集計</h2>
        <span className="font-mono text-[12px] text-ink-7">{bucket} / {label}</span>
        <button className="ghost ml-auto" onClick={onClose} aria-label="閉じる">✕</button>
      </header>

      {status === 'running' && (
        <p className="text-[13px] text-ink-9">
          <span className="cache-banner__dot" aria-hidden /> {scanned.toLocaleString()} 件を走査中…
          <button className="ghost ml-3" onClick={cancel}>中止</button>
        </p>
      )}
      {status === 'canceled' && <p className="text-[13px] text-ink-7">中止しました。</p>}
      {error && <p className="error">{error}</p>}

      {loaded && !result && status === 'idle' && (
        <p className="text-[13px] text-ink-7">まだ走査していません。</p>
      )}

      {result && (
        <>
          <p className="text-[15px]">
            <strong>{result.objectCount.toLocaleString()}</strong> 件 /{' '}
            <strong>{fmtSize(result.totalBytes)}</strong>
            {scannedAt && (
              <span className="ml-2 text-[12px] text-ink-7">
                {new Date(scannedAt).toLocaleString('ja-JP')} に走査
              </span>
            )}
          </p>
          {result.partial && (
            <p className="text-[12px] text-ink-7">
              走査中にエラーが出たため、集計は途中までです。
            </p>
          )}
          {result.children.length > 0 && (
            <table className="w-full text-[13px]">
              <thead><tr><th>サブディレクトリ</th><th>件数</th><th>サイズ</th></tr></thead>
              <tbody>
                {result.children.map(ch => (
                  <tr key={ch.name}>
                    <td className="font-mono">{ch.name}</td>
                    <td className="text-right tabular-nums">{ch.objectCount.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{fmtSize(ch.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {status !== 'running' && (
        <button className="ghost" onClick={start}>
          {result ? '再走査する' : '走査する'}
        </button>
      )}
    </div>
  )
}
```

**注意**: サイズの整形は既存の `fmtSize` を使う (`front/lib/format.ts:3`)。一覧の `EntryTable` も同じ関数を使っているので、表記が揃う。新しい整形関数を作らないこと。

- [ ] **Step 5: StorageBrowser にボタンを足す**

`front/components/StorageBrowser.tsx` の `CacheBanner` の直後に:

```typescript
        {scanOpen && (
          <ScanModal
            connId={connId}
            bucket={bucket}
            prefix={effectivePrefix}
            onClose={() => setScanOpen(false)}
          />
        )}
```

`const [scanOpen, setScanOpen] = useState(false)` を state に足し、`CacheBanner` の隣に開くボタンを置く。走査対象は**いま開いているディレクトリのみ**なので、行の `⋯` メニューには足さないこと。

- [ ] **Step 6: テストが通ることを確認**

Run: `cd front && npx tsc --noEmit && npx vitest run`
Expected: 型エラー無し、全 PASS

- [ ] **Step 7: コミット**

```bash
git add front/lib/api/types.ts front/lib/api/client.ts front/components/storage/ScanModal.tsx front/components/storage/ScanModal.test.tsx front/components/StorageBrowser.tsx
git commit -m "feat(front): ディレクトリ配下の集計モーダルを追加する"
```

---

### Task 11: バケット設定の画面

**Files:**
- Create: `api/routes/bucket-settings.ts`
- Test: `api/routes/bucket-settings.test.ts`
- Modify: `api/internal.ts`
- Modify: `front/lib/api/client.ts`
- Modify: `front/lib/api/types.ts`
- Create: `front/components/BucketSettingsPanel.tsx`
- Test: `front/components/BucketSettingsPanel.test.tsx`
- Modify: `front/pages/StorageIndex.tsx`

**Interfaces:**
- Consumes: `createBucketSettings` (Task 7)
- Produces:
  - `mountBucketSettingsRoutes(app: Hono, deps: { bucketSettings: ReturnType<typeof createBucketSettings> }): void`
  - `GET /storage/:connId/bucket-settings?bucket=` → `{ scanEnabled: boolean; listCacheTtlSec: number }`
  - `PUT /storage/:connId/bucket-settings?bucket=` body `{ key: string; value: string }`
  - `api.bucketSettings(connId, bucket)` / `api.setBucketSetting(connId, bucket, key, value)`

- [ ] **Step 1: 失敗するテストを書く**

`api/routes/bucket-settings.test.ts`:

```typescript
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountBucketSettingsRoutes } from './bucket-settings.js'
import { DEFAULT_BUCKET_SETTINGS } from '../lib/bucket-settings.js'

let stored: Array<[string, string, string, string]> = []
let current = { ...DEFAULT_BUCKET_SETTINGS }

const app = new Hono()
mountBucketSettingsRoutes(app, {
  bucketSettings: {
    get: async () => current,
    set: async (c: string, b: string, k: string, v: string) => { stored.push([c, b, k, v]) },
  },
})

beforeEach(() => { stored = []; current = { ...DEFAULT_BUCKET_SETTINGS } })

describe('bucket-settings ルート', () => {
  it('GET は現在の設定を返す', async () => {
    const res = await app.request('/storage/c1/bucket-settings?bucket=b1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scanEnabled: true, listCacheTtlSec: 86400 })
  })

  it('GET は bucket 必須', async () => {
    expect((await app.request('/storage/c1/bucket-settings')).status).toBe(400)
  })

  it('PUT で設定を書ける', async () => {
    const res = await app.request('/storage/c1/bucket-settings?bucket=b1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'scan_enabled', value: 'false' }),
    })
    expect(res.status).toBe(200)
    expect(stored).toEqual([['c1', 'b1', 'scan_enabled', 'false']])
  })

  // 任意のキーを書けると設定テーブルが野放しになる。
  it('未知の key は 400 で弾く', async () => {
    const res = await app.request('/storage/c1/bucket-settings?bucket=b1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'arbitrary_key', value: 'x' }),
    })
    expect(res.status).toBe(400)
    expect(stored).toHaveLength(0)
  })

  it('list_cache_ttl_sec に数値以外を書こうとしたら 400', async () => {
    const res = await app.request('/storage/c1/bucket-settings?bucket=b1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'list_cache_ttl_sec', value: 'いいかんじ' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run routes/bucket-settings.test.ts`
Expected: FAIL — `Failed to resolve import "./bucket-settings.js"`

- [ ] **Step 3: ルートを書く**

`api/routes/bucket-settings.ts`:

```typescript
import type { Hono } from 'hono'
import { z } from 'zod'
import type { BucketSettings } from '../lib/bucket-settings.js'

// バケット単位の設定の読み書き (spec: 2026-08-18-directory-scan-design.md)。
// 書ける key は allowlist で絞る。任意のキーを書けると設定テーブルが野放しになり、
// 「どの key が意味を持つか」がコードから読めなくなるため。

const ALLOWED_KEYS = ['scan_enabled', 'list_cache_ttl_sec'] as const

const PutBody = z.object({
  key: z.enum(ALLOWED_KEYS),
  value: z.string().min(1).max(64),
}).refine(
  b => b.key !== 'list_cache_ttl_sec' || Number(b.value) > 0,
  { message: 'list_cache_ttl_sec は正の数で指定してください' },
).refine(
  b => b.key !== 'scan_enabled' || b.value === 'true' || b.value === 'false',
  { message: 'scan_enabled は true か false で指定してください' },
)

export interface BucketSettingsDeps {
  bucketSettings: {
    get(connId: string, bucket: string): Promise<BucketSettings>
    set(connId: string, bucket: string, key: string, value: string): Promise<void>
  }
}

export function mountBucketSettingsRoutes(app: Hono, deps: BucketSettingsDeps): void {
  app.get('/storage/:connId/bucket-settings', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    return c.json(await deps.bucketSettings.get(c.req.param('connId'), bucket))
  })

  app.put('/storage/:connId/bucket-settings', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    await deps.bucketSettings.set(
      c.req.param('connId'), bucket, parsed.data.key, parsed.data.value)
    return c.json({ ok: true })
  })
}
```

- [ ] **Step 4: internal.ts に配線する**

```typescript
import { mountBucketSettingsRoutes } from './routes/bucket-settings.js'
```
```typescript
mountBucketSettingsRoutes(api, { bucketSettings })
```

- [ ] **Step 5: フロントの API クライアントを足す**

`front/lib/api/types.ts`:

```typescript
export const BucketSettings = z.object({
  scanEnabled: z.boolean(),
  listCacheTtlSec: z.number(),
})
```

`front/lib/api/client.ts`:

```typescript
  bucketSettings: (connId: string, bucket: string) =>
    getJson(
      buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/bucket-settings`, { bucket }),
      BucketSettings,
    ),

  setBucketSetting: async (
    connId: string, bucket: string, key: string, value: string,
  ): Promise<void> => {
    await mutateJson(
      buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/bucket-settings`, { bucket }),
      { method: 'PUT', body: { key, value } },
      null,
    )
  },
```

- [ ] **Step 6: 設定パネルを書く**

`front/components/BucketSettingsPanel.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BucketSettingsPanel } from './BucketSettingsPanel'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', () => ({
  api: { bucketSettings: vi.fn(), setBucketSetting: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  ;(api.bucketSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    scanEnabled: true, listCacheTtlSec: 86400,
  })
  ;(api.setBucketSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

describe('BucketSettingsPanel', () => {
  it('現在の設定を反映する', async () => {
    render(<BucketSettingsPanel connId="c1" bucket="b1" />)
    expect(await screen.findByRole('checkbox', { name: /走査を許可/ })).toBeChecked()
  })

  it('トグルすると保存する', async () => {
    const user = userEvent.setup()
    render(<BucketSettingsPanel connId="c1" bucket="b1" />)
    await user.click(await screen.findByRole('checkbox', { name: /走査を許可/ }))
    await waitFor(() =>
      expect(api.setBucketSetting).toHaveBeenCalledWith('c1', 'b1', 'scan_enabled', 'false'))
  })
})
```

`front/components/BucketSettingsPanel.tsx`:

```typescript
// バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
// 設定は app_settings (全体) → connection_settings (接続ごと) →
// bucket_settings (バケットごと) の 3 階層で、ここは最も細かい層。

import { useEffect, useState } from 'react'
import { api } from '../lib/api/client'

interface Props {
  connId: string
  bucket: string
}

export function BucketSettingsPanel({ connId, bucket }: Props) {
  const [scanEnabled, setScanEnabled] = useState(true)
  const [ttlSec, setTtlSec] = useState(86400)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.bucketSettings(connId, bucket)
      .then(s => {
        if (cancelled) return
        setScanEnabled(s.scanEnabled)
        setTtlSec(s.listCacheTtlSec)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [connId, bucket])

  const toggleScan = (): void => {
    const next = !scanEnabled
    setScanEnabled(next)
    api.setBucketSetting(connId, bucket, 'scan_enabled', String(next)).catch(() => {})
  }

  if (!loaded) return null

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={scanEnabled} onChange={toggleScan} />
        走査を許可する
      </label>
      <label className="flex items-center gap-2">
        一覧キャッシュの保持
        <input
          type="number"
          min={1}
          value={ttlSec}
          className="w-24"
          onChange={e => setTtlSec(Number(e.target.value))}
          onBlur={() => {
            if (ttlSec > 0) {
              api.setBucketSetting(connId, bucket, 'list_cache_ttl_sec', String(ttlSec))
                .catch(() => {})
            }
          }}
        />
        秒
      </label>
    </div>
  )
}
```

- [ ] **Step 7: StorageIndex のバケット行から開けるようにする**

`front/pages/StorageIndex.tsx` の `BucketLi` に、設定を開くトグルと `BucketSettingsPanel` を足す。既存の `CopyMenu` (`⋯`) の項目として「設定」を追加するのが既存パターンに合う。

- [ ] **Step 8: テストと型検査**

Run: `cd api && npx tsc --noEmit && npm test && cd ../front && npx tsc --noEmit && npx vitest run`
Expected: 型エラー無し、全 PASS

- [ ] **Step 9: コミット**

```bash
git add api/routes/bucket-settings.ts api/routes/bucket-settings.test.ts api/internal.ts front/lib/api/types.ts front/lib/api/client.ts front/components/BucketSettingsPanel.tsx front/components/BucketSettingsPanel.test.tsx front/pages/StorageIndex.tsx
git commit -m "feat: バケット単位の設定画面を追加する"
```

---

### Task 12: 一覧キャッシュ TTL のバケット設定への接続

**Files:**
- Modify: `api/lib/storage-cache.ts`
- Modify: `api/routes/storage-list.ts`
- Modify: `api/internal.ts`
- Modify: `api/lib/storage-cache.test.ts`

**Interfaces:**
- Consumes: `createBucketSettings` (Task 7), `ResponseCache` (既存)
- Produces: `ResponseCache.set(scope, payload, ttlMs?)` — 第 3 引数で TTL を上書きできる

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/storage-cache.test.ts` に追記:

```typescript
it('set の第 3 引数で TTL を上書きできる', async () => {
  const { db, calls } = fakeDb()
  await createResponseCache(db, 86_400_000).set(SCOPE, { ok: true }, 300_000)
  expect(calls[0].values[5]).toBe(300_000)
})

it('第 3 引数を省略すると既定の TTL を使う', async () => {
  const { db, calls } = fakeDb()
  await createResponseCache(db, 86_400_000).set(SCOPE, { ok: true })
  expect(calls[0].values[5]).toBe(86_400_000)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd api && npx vitest run lib/storage-cache.test.ts`
Expected: FAIL — 上書きが効かず `86400000` が入る

- [ ] **Step 3: 実装する**

`api/lib/storage-cache.ts` の `ResponseCache` を変更:

```typescript
  /** ttlMs を渡すと既定を上書きする (バケットごとの list_cache_ttl_sec 用)。 */
  set(scope: CacheScope, payload: unknown, ttlMs?: number): Promise<void>
```

実装の `set` を変更:

```typescript
    async set(scope, payload, overrideTtlMs) {
      try {
        await db.query(
          /* SQL は変更なし */,
          [
            cacheKey(scope), scope.connId, scope.bucket ?? '', scope.prefix ?? '',
            JSON.stringify(payload), overrideTtlMs ?? ttlMs,
          ],
        )
      } catch (e) { swallow('set', e) }
    },
```

`api/routes/storage-list.ts` の `StorageListDeps` に追加:

```typescript
  /** バケットごとの一覧キャッシュ TTL (秒)。 */
  getListCacheTtlSec: (connId: string, bucket: string) => Promise<number>
```

`/list` と `/buckets` の `await deps.cache.set(scope, body)` を差し替え:

```typescript
    // /buckets は bucket が無いので既定 TTL のまま
    await deps.cache.set(scope, body)
```
```typescript
    // /list はバケットごとの TTL を使う
    await deps.cache.set(scope, body, (await deps.getListCacheTtlSec(connId, bucket)) * 1000)
```

`api/internal.ts` の `mountStorageListRoutes` に追加:

```typescript
  getListCacheTtlSec: async (connId, bucket) =>
    (await bucketSettings.get(connId, bucket)).listCacheTtlSec,
```

- [ ] **Step 4: テストと型検査**

Run: `cd api && npx tsc --noEmit && npm test`
Expected: 型エラー無し、全 PASS

- [ ] **Step 5: コミット**

```bash
git add api/lib/storage-cache.ts api/lib/storage-cache.test.ts api/routes/storage-list.ts api/internal.ts
git commit -m "feat(api): 一覧キャッシュ TTL をバケットごとに設定できるようにする"
```

---

### Task 13: 本番適用と受け入れ確認

**Files:** なし (運用作業)

- [ ] **Step 1: 全体の検査**

```bash
cd api && npx tsc --noEmit && npm test && cd ../front && npx tsc --noEmit && npx vitest run
```
Expected: 型エラー無し、api / front とも全 PASS

- [ ] **Step 2: push**

```bash
git push origin main
```

- [ ] **Step 3: 本番 DB のバックアップとマイグレーション適用**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc \
  'cd ~/mado && docker compose -f compose.prod.yaml exec -T postgres \
     pg_dump -U postgres -d dashboard > ~/dashboard-backup-$(date +%Y%m%d-%H%M).sql'

ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc \
  'cd ~/mado && git pull origin main && for f in 017_jobs 018_bucket_settings; do
     docker compose -f compose.prod.yaml exec -T postgres \
       psql -v ON_ERROR_STOP=1 -U postgres -d dashboard -f /migrations/$f.sql
   done'
```
Expected: `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE` / `GRANT` が両方のファイルで成功

- [ ] **Step 4: デプロイ**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc 'cd ~/mado && ./deploy.sh'
```
Expected: exit 0。`| tail` を挟まないこと (終了コードが握り潰される)

- [ ] **Step 5: 受け入れ確認**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc '
C=mW5dNSSMcQ
# 1. 小さいバケット
J=$(curl -s -X POST "http://localhost/api/internal/storage/$C/scan?bucket=trash" | sed "s/[^0-9]//g")
sleep 5
curl -s "http://localhost/api/internal/jobs/$J"
echo
# 2. 二重投入で同じ id が返る
A=$(curl -s -X POST "http://localhost/api/internal/storage/$C/scan?bucket=dataset" | sed "s/[^0-9]//g")
B=$(curl -s -X POST "http://localhost/api/internal/storage/$C/scan?bucket=dataset" | sed "s/[^0-9]//g")
echo "合流: $A = $B"
'
```
Expected:
1. `trash` の走査が数秒で `done` になり、`result.objectCount` が 3
2. `dataset` の二重投入で同じ id が返る

- [ ] **Step 6: `dataset` の走査を完走させる**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc '
for i in $(seq 1 40); do
  s=$(curl -s "http://localhost/api/internal/jobs/<JOB_ID>" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(j.status, j.progress?j.progress.done:0)})")
  echo "$s"
  case "$s" in done*) break;; esac
  sleep 15
done'
```
Expected: 約 4 分で `done`。`result.objectCount` が **547,259**、`result.totalBytes` が約 903 TB (2026-08-17 の実測と一致すること)

- [ ] **Step 7: `scan_enabled=false` のガードを確認**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc '
cd ~/mado && docker compose -f compose.prod.yaml exec -T postgres psql -U postgres -d dashboard -c \
  "INSERT INTO bucket_settings (connection_id, bucket, key, value) VALUES (\$\$mW5dNSSMcQ\$\$, \$\$dataset\$\$, \$\$scan_enabled\$\$, \$\$false\$\$) ON CONFLICT (connection_id, bucket, key) DO UPDATE SET value = EXCLUDED.value;"
curl -s -o /dev/null -w "POST scan -> %{http_code}\n" -X POST "http://localhost/api/internal/storage/mW5dNSSMcQ/scan?bucket=dataset"
curl -s -o /dev/null -w "GET latest -> %{http_code}\n" "http://localhost/api/internal/jobs/latest?kind=storage.scan&dedupKey=mW5dNSSMcQ%0Adataset%0A"
'
```
Expected: `POST` が 403、`GET latest` は 200 (過去の結果は読める)

- [ ] **Step 8: 設定を戻す**

```bash
ssh mdxuser@mado.mdx.internal -i ~/.ssh/mdx-dataset-acc \
  'cd ~/mado && docker compose -f compose.prod.yaml exec -T postgres psql -U postgres -d dashboard -c \
     "DELETE FROM bucket_settings WHERE key = '"'"'scan_enabled'"'"';"'
```
