# デフォルト接続 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** デフォルト接続の概念を追加し、Storage タブがデフォルト接続へ直行するようにする（接続選択画面は廃止、切り替えは CONN スイッチャー）。

**Architecture:** `storage_connections.is_default` boolean + 部分ユニークインデックス（デフォルトは常に 1 件以下を DB 保証）。`PUT /connections/:id/default` でトランザクション切り替え。StorageLanding は「デフォルト → created_at 最古 → 空状態」の 3 分岐で直行。Settings の接続行にバッジ + ワンクリック切り替え。

**Tech Stack:** Hono / pg / React 19 / zod / vitest

**Spec:** `docs/superpowers/specs/2026-07-07-default-connection-design.md`

## Global Constraints

- ブランチ: feature/audio-explorer に積む（新ブランチは切らない）
- コミットメッセージは既存流儀（`feat:` / `fix:` / `test:` + 日本語）
- api / front とも `npm test`・lint が通ること。front lint は main 由来の既存 4 エラーが baseline（新規エラーを増やさない）
- api の DB テストは実行前に同一シェルで:
  ```bash
  RWURL=$(grep '^DATABASE_URL_RW=' /Users/aida/PhpstormProjects/web-dashboard/.env | cut -d= -f2-); PW=$(echo "$RWURL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|'); export DATABASE_URL_RW_TEST="postgres://dashboard_rw:${PW}@localhost:5432/dashboard_test"
  ```
- `git stash` は使用禁止。自分のコミット以外の git 状態を変更しない
- postgres コンテナは起動済み（`mado-dev-postgres`）

---

### Task 1: マイグレーション 007 + API (isDefault / PUT default)

**Files:**
- Create: `db/migrations/007_default_connection.sql`
- Modify: `api/routes/connections.ts`
- Test: `api/routes/connections.test.ts`（既存に追記）

**Interfaces:**
- Produces:
  - `GET /connections` の各要素に `isDefault: boolean`
  - `PUT /connections/:id/default` → `200 {ok: true}` / 404 `{error: 'connection not found'}`
  - DB: `storage_connections.is_default boolean NOT NULL DEFAULT false` + 部分ユニークインデックス `storage_connections_default ON storage_connections(is_default) WHERE is_default`

- [ ] **Step 1: マイグレーションを書く**

`db/migrations/007_default_connection.sql`:

```sql
-- デフォルト接続 (spec: 2026-07-07-default-connection-design.md)
-- Storage タブはデフォルト接続へ直行する。デフォルトは常に 1 件以下。
-- 権限の追記は不要: 既存テーブルへの ALTER は所有者 (dashboard_rw) を変えず、
-- インデックスは常に親テーブルの所有者に属する。

ALTER TABLE storage_connections
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS storage_connections_default
  ON storage_connections (is_default) WHERE is_default;

-- 既存環境: 登録順で最初の接続をデフォルトに焼き込む (0 件 / 既にあるなら no-op)
UPDATE storage_connections SET is_default = true
 WHERE id = (SELECT id FROM storage_connections ORDER BY created_at, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM storage_connections WHERE is_default);
```

- [ ] **Step 2: dev / test 両 DB に適用**

```bash
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d dashboard -f /migrations/007_default_connection.sql
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d dashboard_test -f /migrations/007_default_connection.sql
```

Expected: `ALTER TABLE` / `CREATE INDEX` / `UPDATE n`（dev は既存接続数に応じ 1、test は 0）

- [ ] **Step 3: 失敗するテストを書く**

`api/routes/connections.test.ts` の既存 describe 内に追記（既存の app 構築・seed ヘルパーの流儀に合わせる。以下は要旨 — 実ファイルのヘルパー名を確認して適合させること）:

```ts
describe('default connection', () => {
  it('GET /connections は isDefault を返す (初期は全て false)', async () => {
    // 既存の作成ヘルパー or POST で 2 件作る
    const list = (await (await app.request('/connections')).json()) as Array<{ id: string; isDefault: boolean }>
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.every(c => c.isDefault === false)).toBe(true)
  })

  it('PUT /:id/default で切り替わり、常に 1 件だけ true', async () => {
    const list = (await (await app.request('/connections')).json()) as Array<{ id: string }>
    const [a, b] = list
    let res = await app.request(`/connections/${a.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)
    let after = (await (await app.request('/connections')).json()) as Array<{ id: string; isDefault: boolean }>
    expect(after.filter(c => c.isDefault).map(c => c.id)).toEqual([a.id])

    res = await app.request(`/connections/${b.id}/default`, { method: 'PUT' })
    expect(res.status).toBe(200)
    after = (await (await app.request('/connections')).json()) as Array<{ id: string; isDefault: boolean }>
    expect(after.filter(c => c.isDefault).map(c => c.id)).toEqual([b.id])
  })

  it('存在しない id は 404', async () => {
    const res = await app.request('/connections/nonexistent1/default', { method: 'PUT' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: 失敗を確認**

Run: `cd api && npx vitest run routes/connections.test.ts`（DB export 必須）
Expected: FAIL（isDefault が undefined / PUT ルートが 404 でなく route not found）

- [ ] **Step 5: connections.ts を実装**

`api/routes/connections.ts`:
- `ConnectionRow` に `is_default: boolean` を追加
- `toMasked` の戻り値に `isDefault: row.is_default,` を追加
- 全ての `SELECT ... FROM storage_connections`（GET 一覧 / PUT 更新前 SELECT / POST・PUT の RETURNING）のカラムリストに `is_default` を追加
- `mountConnectionsRoutes` に PUT ルートを追加（既存 `app.put('/connections/:id', ...)` の**前**に置く — Hono はパス長で区別するので順序は実際は不問だが、可読性のため default を先に）:

```ts
  // デフォルト接続の切り替え。トランザクションで「全解除 → 対象を設定」し、
  // 部分ユニークインデックス (storage_connections_default) が 1 件以下を保証する。
  app.put('/connections/:id/default', async c => {
    const id = c.req.param('id')
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE storage_connections SET is_default = false WHERE is_default')
      const r = await client.query(
        'UPDATE storage_connections SET is_default = true WHERE id = $1',
        [id],
      )
      if (r.rowCount === 0) {
        await client.query('ROLLBACK')
        return c.json({ error: 'connection not found' }, 404)
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    return c.json({ ok: true })
  })
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd api && npx vitest run routes/connections.test.ts && npx tsc --noEmit && npm run lint && npm test`（DB export 必須）
Expected: 全て PASS

- [ ] **Step 7: Commit**

```bash
git add db/migrations/007_default_connection.sql api/routes/connections.ts api/routes/connections.test.ts
git commit -m "feat: デフォルト接続のマイグレーションと API を追加"
```

---

### Task 2: front クライアント (isDefault / setDefaultConnection)

**Files:**
- Modify: `front/lib/api/types.ts`, `front/lib/api/client.ts`
- Test: `front/lib/api/media-client.test.ts` ではなく新規 `front/lib/api/connections-client.test.ts`

**Interfaces:**
- Consumes: Task 1 の API
- Produces:
  - `Connection` zod 型に `isDefault: z.boolean()`
  - `api.setDefaultConnection(id: string): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`front/lib/api/connections-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

describe('connections client', () => {
  it('listConnections は isDefault を parse する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{
      id: 'c1', name: 'n', endpoint: 'http://e', region: 'r',
      accessKeyIdMasked: 'x…y', forcePathStyle: true, listObjectsVersion: 'v2',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      isDefault: true,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const list = await api.listConnections()
    expect(list[0].isDefault).toBe(true)
  })

  it('setDefaultConnection は PUT /connections/:id/default を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.setDefaultConnection('c 1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/connections/c%201/default')
    expect((init as RequestInit).method).toBe('PUT')
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run lib/api/connections-client.test.ts`
Expected: FAIL（isDefault が zod で落ちる / setDefaultConnection 未定義）

- [ ] **Step 3: 実装**

`front/lib/api/types.ts` — `Connection` に追加:

```ts
  isDefault: z.boolean(),
```

`front/lib/api/client.ts` — `api` オブジェクトの `deleteConnection` の後に追加:

```ts
  // デフォルト接続の切り替え。listConnections はキャッシュ層を通らないため
  // 呼び出し後の再取得だけで最新が見える。
  setDefaultConnection: async (id: string): Promise<void> => {
    await mutateJson(
      `${API_BASE}/connections/${encodeURIComponent(id)}/default`,
      { method: 'PUT' },
      z.object({ ok: z.boolean() }),
    )
  },
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run lib/api/connections-client.test.ts && npx tsc -b && npm test`
Expected: PASS（既存テストで Connection の mock を使っている箇所が isDefault 欠落で落ちる場合は、その mock に `isDefault: false` を足して直す — 変更内容をレポートに記録）

- [ ] **Step 5: Commit**

```bash
git add front/lib/api/types.ts front/lib/api/client.ts front/lib/api/connections-client.test.ts
git commit -m "feat: front に isDefault と setDefaultConnection を追加"
```

---

### Task 3: StorageLanding の直行化

**Files:**
- Modify: `front/pages/StorageLanding.tsx`
- Test: `front/pages/StorageLanding.test.tsx`（新規）

**Interfaces:**
- Consumes: `api.listConnections()`（isDefault 付き）
- Produces: Storage タブの挙動 — デフォルト接続 → created_at 最古 → 0 件なら空状態。**選択画面 UI は削除**

- [ ] **Step 1: 失敗するテストを書く**

`front/pages/StorageLanding.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StorageLanding from './StorageLanding'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return { api: { ...mod.api, listConnections: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const conn = (id: string, createdAt: string, isDefault = false) => ({
  id, name: id, endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: true, listObjectsVersion: 'v2' as const,
  createdAt, updatedAt: createdAt, isDefault,
})

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/storage']}>
      <Routes>
        <Route path="/storage" element={<StorageLanding />} />
        <Route path="/storage/:connId/*" element={<output data-testid="dest" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StorageLanding', () => {
  it('デフォルト接続へ直行する (複数あっても選択画面を出さない)', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([
      conn('older', '2026-01-01T00:00:00Z'),
      conn('newer-default', '2026-06-01T00:00:00Z', true),
    ])
    renderLanding()
    await waitFor(() => expect(screen.getByTestId('dest')).toBeInTheDocument())
    expect(screen.queryByText('接続を選択')).not.toBeInTheDocument()
  })

  it('デフォルト未設定なら created_at 最古へ', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([
      conn('newer', '2026-06-01T00:00:00Z'),
      conn('oldest', '2026-01-01T00:00:00Z'),
    ])
    renderLanding()
    await waitFor(() => expect(screen.getByTestId('dest')).toBeInTheDocument())
  })

  it('0 件なら空状態', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([])
    renderLanding()
    await waitFor(() => expect(screen.getByText('接続がまだありません')).toBeInTheDocument())
  })
})
```

注意: 遷移先 id の検証を厳密にしたい場合は dest ルートで useParams を読んで data 属性に出す形にする（実装時に判断、最低限「遷移した」ことと「選択画面が出ない」ことを assert）。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run pages/StorageLanding.test.tsx`
Expected: FAIL（複数接続で選択画面が出る）

- [ ] **Step 3: StorageLanding を書き換え**

`front/pages/StorageLanding.tsx` — 選択リスト UI を削除し、遷移ロジックを差し替え:

```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'

// Storage タブの入口。デフォルト接続 → created_at 最古 → 0 件なら空状態、へ振り分ける。
// 接続の切り替えは画面右上の CONN スイッチャーが担うため、選択画面はもう無い。
function pickConnection(list: Connection[]): Connection | null {
  if (list.length === 0) return null
  return (
    list.find(c => c.isDefault)
    ?? [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
  )
}

export default function StorageLanding() {
  const [empty, setEmpty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listConnections()
      .then(list => {
        const target = pickConnection(list)
        if (target) navigate(`/storage/${encodeURIComponent(target.id)}/`, { replace: true })
        else setEmpty(true)
      })
      .catch(e => setError((e as Error).message))
  }, [navigate])

  if (error) return <p className="error">{error}</p>
  if (!empty) return <p className="text-[13px] text-ink-7">読み込み中…</p>
  return (
    <div className="empty-state">
      <h2>接続がまだありません</h2>
      <p>
        ここに表示する S3 互換ストレージはまだ登録されていません。<br />
        設定ページから一つ追加してみましょう。
      </p>
      <Link className="empty-state__cta" to="/connections">接続を追加</Link>
    </div>
  )
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run pages/StorageLanding.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（lint 新規エラーなし）

- [ ] **Step 5: Commit**

```bash
git add front/pages/StorageLanding.tsx front/pages/StorageLanding.test.tsx
git commit -m "feat: Storage タブをデフォルト接続へ直行させる"
```

---

### Task 4: Settings のバッジ + デフォルト切り替えボタン

**Files:**
- Modify: `front/pages/ConnectionsPage.tsx`, `README.md`
- Test: `front/pages/ConnectionsPage.default.test.tsx`（新規）

**Interfaces:**
- Consumes: `api.setDefaultConnection(id)` (Task 2)、`Connection.isDefault`
- Produces: 接続行に `DEFAULT` バッジ（isDefault 時）/「デフォルトにする」ボタン（それ以外）。クリックで PUT → 一覧再取得

- [ ] **Step 1: 失敗するテストを書く**

`front/pages/ConnectionsPage.default.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './ConnectionsPage'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      listConnections: vi.fn(),
      setDefaultConnection: vi.fn(),
    },
  }
})

afterEach(() => vi.clearAllMocks())

const conn = (id: string, isDefault: boolean) => ({
  id, name: id, endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: false, listObjectsVersion: 'v2' as const,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault,
})

describe('ConnectionsPage デフォルト切り替え', () => {
  it('デフォルト行にバッジ、他の行にボタンが出る', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn('a', true), conn('b', false)])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('DEFAULT')).toBeInTheDocument())
    expect(screen.getAllByText('デフォルトにする')).toHaveLength(1)
  })

  it('ボタンで setDefaultConnection が呼ばれ一覧を再取得する', async () => {
    vi.mocked(api.listConnections)
      .mockResolvedValueOnce([conn('a', true), conn('b', false)])
      .mockResolvedValueOnce([conn('a', false), conn('b', true)])
    vi.mocked(api.setDefaultConnection).mockResolvedValue(undefined)
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('デフォルトにする')).toBeInTheDocument())
    fireEvent.click(screen.getByText('デフォルトにする'))
    await waitFor(() => expect(api.setDefaultConnection).toHaveBeenCalledWith('b'))
    expect(api.listConnections).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run pages/ConnectionsPage.default.test.tsx`
Expected: FAIL

- [ ] **Step 3: ConnectionsPage を実装**

`front/pages/ConnectionsPage.tsx`:
- 接続名の `<strong>` の隣（同じ行内）にバッジ / ボタン:

```tsx
{conn.isDefault ? (
  <span
    className="ml-2 align-middle text-[9.5px] font-semibold uppercase tracking-[0.18em] text-ink-7"
    style={{ border: '1px solid var(--rule)', borderRadius: 2, padding: '1px 5px' }}
    title="Storage タブはこの接続を開きます"
  >
    default
  </span>
) : null}
```

- アクション部（`開く / 編集 / 削除` の flex 内、`開く` の前）に:

```tsx
{!conn.isDefault && (
  <button
    className="ghost"
    onClick={() => void handleSetDefault(conn.id)}
    title="Storage タブで開く接続にする"
  >
    デフォルトにする
  </button>
)}
```

- ハンドラ（既存の handleCreate 等の隣、reload は既存の一覧再取得処理を使う — 実ファイルの reducer / load 関数名に合わせる）:

```tsx
const handleSetDefault = async (id: string) => {
  try {
    await api.setDefaultConnection(id)
    // 既存の load() / dispatch(loadOk) パターンで一覧を再取得
    const rows = await api.listConnections()
    dispatch({ type: 'loadOk', rows })
  } catch (e) {
    dispatch({ type: 'loadError', message: (e as Error).message }) // 実際のエラー action 名に合わせる
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run pages/ConnectionsPage.default.test.tsx && npm test && npx tsc -b && npm run lint`
Expected: PASS（既存の ConnectionsPage テストが isDefault 欠落 mock で落ちたら mock に `isDefault: false` を足す）

- [ ] **Step 5: README を更新**

`README.md` の「2. バケット / ディレクトリをブラウズする (Storage)」冒頭の一文
「**Storage** タブで接続を選びます (登録が 1 つだけなら自動で開きます)。」を
「**Storage** タブは**デフォルト接続**を自動で開きます。別の接続に切り替えるときは右上の **CONN** メニュー、デフォルトの変更は **Settings** の各接続行の「デフォルトにする」から。」に差し替える。
Settings の説明（「1. ストレージ接続を登録する」の末尾「登録した接続は後から編集・削除できます。」）を「登録した接続は後から編集・削除でき、Storage タブが開くデフォルト接続もここで変更できます。」に更新。

- [ ] **Step 6: 動作確認 (dev スタック)**

```bash
# ブラウザ http://localhost:5173/connections で:
# - minio-e2e 行に DEFAULT バッジ (007 の焼き込みで最古 = 唯一の接続がデフォルト)
# - Storage タブ → minio-e2e に直行
```

- [ ] **Step 7: Commit**

```bash
git add front/pages/ConnectionsPage.tsx front/pages/ConnectionsPage.default.test.tsx README.md
git commit -m "feat: Settings にデフォルト接続の表示と切り替えを追加"
```
