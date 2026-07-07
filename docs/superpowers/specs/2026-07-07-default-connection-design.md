# デフォルト接続

## 背景

Storage タブは現在、接続が 1 件なら自動遷移、複数なら選択画面を表示する。複数接続を登録している環境では毎回選択画面を経由することになるが、実際には「普段使う接続」はほぼ固定で、切り替えたいときだけ選べれば良い。

そこで「デフォルト接続」の概念を追加する。Storage タブは常にデフォルト接続へ直行し、接続の切り替えは画面右上の CONN スイッチャーで行う。デフォルトは Settings（接続一覧）から変更できる。

## 目的

- Storage タブを開いたら（接続が 1 件でも複数でも）デフォルト接続のバケット一覧に直行する
- デフォルトは Settings の接続一覧からワンクリックで変更できる
- 既存環境では登録順で最初（`created_at` 最古）の接続がデフォルトになる

## 設計

### DB (`db/migrations/007_default_connection.sql`)

```sql
ALTER TABLE storage_connections
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- デフォルトは常に 1 件以下であることを DB が保証する
CREATE UNIQUE INDEX IF NOT EXISTS storage_connections_default
  ON storage_connections (is_default) WHERE is_default;

-- 既存環境: 登録順で最初の接続をデフォルトに焼き込む (接続 0 件なら no-op)
UPDATE storage_connections SET is_default = true
 WHERE id = (SELECT id FROM storage_connections ORDER BY created_at, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM storage_connections WHERE is_default);
```

権限まわりの追記は不要: 既存テーブルへの ALTER はテーブル所有者 (dashboard_rw) を変えず、Postgres のインデックスは常に親テーブルの所有者に属する（postgres で適用しても dashboard_rw 所有になる）。006 のような ALTER/GRANT ブロックはこのマイグレーションには要らない。

### API (`api/routes/connections.ts` 拡張)

- `GET /connections` — 各要素に `isDefault: boolean` を追加
- `PUT /connections/:id/default` — 新設。トランザクションで `UPDATE ... SET is_default = false WHERE is_default` → `UPDATE ... SET is_default = true WHERE id = $1`。対象が存在しなければ 404。write 系なので既存の Origin チェック配下
- 削除 API は変更なし。デフォルト接続を削除すると単に「デフォルト未設定」状態に戻る

### フロントエンド

- **`StorageLanding`**: 遷移先の決定を次の優先順位に変更し、**複数接続でも選択画面は出さない**
  1. `isDefault` の接続 → 直行
  2. なければ登録順で最初の接続 → 直行（デフォルト削除後のフォールバック）
  3. 接続 0 件 → 既存の空状態（接続を追加への導線）
  - 接続の切り替えは既存の CONN スイッチャー（画面右上）が担う。従来の選択画面 UI は不要になるため削除する
- **`ConnectionsPage`（Settings）**: 各接続行に、デフォルトなら `DEFAULT` バッジ、それ以外には「デフォルトにする」ボタンを表示。クリックで `PUT /connections/:id/default` → 一覧を再取得
- **API クライアント**: `Connection` zod 型に `isDefault` を追加、`setDefaultConnection(id)` を追加。`listConnections` は TTLCache を通っていない（毎回 fetch）ため、キャッシュ無効化の対応は不要
- **`ConnectionSwitcher`**: 変更なし（`isDefault` フィールドは単に無視される）

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| デフォルト接続を削除 | 未設定状態。Storage タブは登録順で最初の接続へフォールバック |
| `PUT /:id/default` の対象が存在しない | 404 |
| 同時に 2 つデフォルト化（並行リクエスト） | 部分ユニークインデックスにより後勝ちで直列化（トランザクション内で全解除→設定） |
| 接続 0 件で Storage タブ | 既存の空状態表示（変更なし） |

## テスト

- **API**: `isDefault` が一覧に出る / `PUT default` の切り替え排他性（A→B と切り替えて常に 1 件だけ true）/ 存在しない id は 404 / Origin チェック対象であること
- **マイグレーション**: 適用後、最古の接続に `is_default = true`（既にデフォルトがある場合は変更しない）
- **フロント**: StorageLanding の 3 分岐（デフォルトあり→直行 / なし→最初へ / 0 件→空状態）、ConnectionsPage のバッジ表示と切り替えボタンの動作

## ロールバック

- フロント: StorageLanding の分岐を戻し、ConnectionsPage のバッジ/ボタンを外す
- DB: インデックスとカラムを drop
