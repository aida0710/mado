# バケット / ディレクトリ / ファイルへのタグ付け

## 背景

複数の S3 互換ストレージを横断してバケット・ディレクトリ・ファイルを管理していると、「これは重要」「未整理」「解析済み」のような目印を付けたい場面や、同じ目印が付いたものを一括で探したい場面が出てくる。README (自由記述のメモ) はこれをカバーしない — 一覧上で一目でわかる視覚的タグと、それを起点にした検索が必要。

## 目的

- バケット / ディレクトリ / ファイルのそれぞれに、色付きの事前定義タグを複数付けられる
- 一覧 (バケット一覧・ディレクトリ/ファイル一覧) でタグがバッジとして見える (分類・目印)
- 一覧内でタグによる絞り込みができる
- 同一接続内の全バケットを横断して、特定タグが付いた対象を検索できる
- タグの語彙 (名前・色) は事前定義制。新規作成・編集・削除は Settings で行う (LAN 全体で共有、`storage_connections` をまたいでグローバル)

## スコープ外

- 複数接続 (複数 S3 アカウント) を跨いだ横断検索 — 検索は同一接続内のみ
- 「今開いているディレクトリ自身」をその場で直接タグ編集する専用 UI (README の編集ページのような専用画面) — 親の一覧の行から編集する動線のみで足りる
- タグ割り当ての履歴記録 (誰がいつ付け外ししたか)
- タグ名の自由入力 (都度の自由記述タグ)

## データモデル

README・favorites と同じく、S3 側には書き込まず Postgres に LAN 共有メタデータとして保存する。

```sql
-- 事前定義タグのレジストリ。全接続共通 (connection_id を持たない)。
CREATE TABLE storage_tags (
  id         TEXT        PRIMARY KEY,        -- nanoid(10)
  name       TEXT        NOT NULL UNIQUE,
  color      TEXT        NOT NULL,            -- '#RRGGBB'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(name) BETWEEN 1 AND 32),
  CHECK (color ~ '^#[0-9a-fA-F]{6}$')
);

-- タグの割り当て。bucket 自体 / prefix (ディレクトリ) / file (key) の
-- 3種類の対象をひとつのテーブルで表現する (target_kind で判別)。
-- 種別ごとにテーブルを分けず統合することで、CRUD ロジックの重複
-- (bucket用/prefix用/file用でほぼ同じルートが3本) を避ける。
CREATE TABLE storage_tag_assignments (
  tag_id        TEXT        NOT NULL REFERENCES storage_tags(id) ON DELETE CASCADE,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  target_kind   TEXT        NOT NULL CHECK (target_kind IN ('bucket','prefix','file')),
  target_path   TEXT        NOT NULL DEFAULT '',  -- bucket: '' / prefix: 'a/b/' / file: 'a/b/c.txt'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, target_kind, target_path, tag_id)
);

CREATE INDEX storage_tag_assignments_tag_idx ON storage_tag_assignments (tag_id);

-- 既存テーブルと同じく rw 所有 + ro SELECT (db/init/00-init.sh の
-- ALTER DEFAULT PRIVILEGES はマイグレーション実行ユーザ (postgres) には
-- 効かないので、002_readme_history.sql と同様にここで明示する)。
ALTER TABLE storage_tags             OWNER TO dashboard_rw;
ALTER TABLE storage_tag_assignments  OWNER TO dashboard_rw;
GRANT SELECT ON storage_tags, storage_tag_assignments TO dashboard_ro;
```

タグをレジストリから削除すると `ON DELETE CASCADE` で全ての割り当ても連動して消える。`connection_id` を消すと (既存の CASCADE 通り) その接続の割り当てだけ消える。

## API 設計

新規ファイル `api/routes/storage-tags.ts`。`internal.ts` にマウント。README/favorites と同じ「オナーシステム」— 認証なし、write 系は既存の Origin チェックに委ねる。

### タグレジストリ管理 (グローバル、接続に依存しない)

```
GET    /api/internal/tags              → [{ id, name, color }]
POST   /api/internal/tags              body: { name, color }   → { id, name, color }
PATCH  /api/internal/tags/:id          body: { name?, color? } → { id, name, color }
DELETE /api/internal/tags/:id                                   → { ok: true }
```

- `name` は UNIQUE 制約により重複作成は 409。
- `color` は `#RRGGBB` 形式を zod でバリデート。

### タグの割り当て (接続ごと)

```
GET    /api/internal/storage/:connId/tags?bucket=&kind=bucket|prefix|file&paths=a&paths=b
       → { [path]: string[] }   // path → 割り当て済み tagId[]。一覧をまとめて hydrate するバッチ取得
       // paths はカンマ結合ではなく繰り返しクエリ (path に任意文字を許すため)

PUT    /api/internal/storage/:connId/tags   body: { bucket, kind, path, tagId } → { ok: true }
DELETE /api/internal/storage/:connId/tags   body: { bucket, kind, path, tagId } → { ok: true }
```

- `kind: 'bucket'` のときは `path` を常に `''` に正規化する (bucket 自体を表す)。
- PUT は `ON CONFLICT DO NOTHING` で冪等。

### タグの横断検索 (同一接続内の全バケット)

```
GET /api/internal/storage/:connId/tags/search?tagId=a&tagId=b
  → [{ tagId, bucket, kind, path }]   // 選んだタグのいずれかを含む対象を bucket, kind, path 順で列挙
                                        // DB 完結。S3 API 呼び出し不要
```

## フロントエンド設計

### 新規コンポーネント

- **`TagBadge.tsx`** — 色付きの小さいピル。名前 + 背景色、テキスト色は背景の輝度から自動でコントラスト調整 (黒 or 白)。
- **`TagPicker.tsx`** — 対象 1 件 (bucket/prefix/file) に対するタグ選択ポップオーバー。レジストリ全件をチェックボックスで表示し、トグルで PUT/DELETE を即時反映。新規タグ作成はここではできない (Settings 側のみ)。
- **`TagFilterBar.tsx`** — 一覧画面 (ディレクトリ/ファイル一覧・バケット一覧) の上部に出す絞り込みチップ。**今表示中の行に実際に出現するタグだけ**を候補にし、選んだタグを**いずれか含む** (OR) 行だけに絞り込む (クライアント側フィルタ、取得済みデータに対して行う)。
- **`TagSearchPanel.tsx`** — `ReadmeSearchPanel` と同じ位置 (`StorageIndex` 上部) に設置。タグを 1 つ以上選ぶと `/tags/search` を叩き、同一接続内の全バケットを横断してヒットした bucket / ディレクトリ / ファイルへのリンク一覧を表示。
- **`TagsSettings.tsx`** — Settings タブ (`ConnectionsPage.tsx`) に追加するセクション。タグの新規作成・名前/色編集・削除 (`ConnectionForm` と同様の構成)。

### 既存箇所への組み込み

- `EntryTable.tsx` の `DirRow`/`FileRow` (Card 版含む) — 行内に `TagBadge` を並べ、既存の `CopyMenu` items 配列に「タグを編集」action を追加して `TagPicker` を開く。
- `StorageIndex.tsx` の `BucketLi` — 同様にバッジ表示 + タグ編集トリガーを追加。上部に `TagSearchPanel` を設置。
- `StorageBrowser.tsx` (EntryTable の親) — 一覧取得後にバッチ GET (`/tags?kind=...&paths=...`) でタグ割り当てをまとめて取得し、`tagsByPath` として `EntryTable` に渡す。`TagFilterBar` をここに設置。
- `lib/api/client.ts` / `types.ts` — 上記 API に対応するメソッドと zod スキーマを追加。favorites のキャッシュ方式 (`api.lastFetched`, `api.invalidateXxx`) を踏襲する。

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| タグ名重複作成 | 409 を Settings 側でエラー表示 |
| 削除済みタグが割り当てに残っていた形跡 | `ON DELETE CASCADE` で発生しない (割り当ても連動して消える) |
| 割り当て対象 (bucket/prefix/key) が後で S3 から消えた | タグ割り当ては DB に残り続ける (v1 では自動掃除しない)。一覧には出てこなくなるだけで実害はない |
| バッチ GET で `paths` が空 | 空オブジェクト `{}` を返す |

## テスト

- API: `storage-tags.test.ts` — レジストリ CRUD (重複 409 含む)、割り当て PUT/DELETE の冪等性、バッチ GET、`/tags/search` の複数 tagId OR 検索、カスケード削除
- フロント: `TagBadge`/`TagPicker`/`TagFilterBar`/`TagSearchPanel` の単体テスト、`EntryTable`/`StorageIndex` への組み込みテスト (既存の `EntryTable.pin.test.tsx` 相当のパターン)

## ロールバック

- 新規テーブル 2 つ + 新規ルートファイル 1 つ + 新規フロントコンポーネント群。既存ファイルへの変更は「バッジ表示 + メニュー項目追加」の小差分に限定されるため、機能ごと外すのは比較的容易。
