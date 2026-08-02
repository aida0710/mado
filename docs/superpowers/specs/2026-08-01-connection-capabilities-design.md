# 接続ごとの権限トグルと、機能の全体トグル

## 背景

Mado は「一覧を眺める」用途と「中身を触る」用途が同じ画面に同居している。ファイル行をクリックすればプレビューが開き、`⋯` からダウンロードでき、tar を開けば中身が展開され、音声を開けば解析が走り、README は編集してバケットへ書き戻される。

これが困る接続がある:

- **Glacier Deep Archive** — オブジェクトは一覧には出るが、`GetObject` 自体が `InvalidObjectState` で失敗するか、復元して課金される。プレビューを開いただけで踏む。
- **本番バケット** — 眺めるのは良いが README を書き戻したくない。
- **巨大な音声シャード** — 波形/スペクトログラムの解析はファイル全体をダウンロードするので、うっかり開くと重い。

「一覧表示は良いが、書き込みやダウンロードはまずい」を接続単位で表明できるようにする。

## 目的

- 接続ごとに、許可する操作をトグルで選べる
- **既定はすべて許可**。マイグレーション後の挙動は適用前と完全に同じで、危険な接続だけ後から落とす
- UI で導線を隠すだけでなく、**API 側でも 403 で止める** — Mado は共有 Web URL (`?preview=<key>`) を配れるので、UI を隠すだけでは意味がない
- あわせて、タグ / 家系図を Mado 全体で出すかどうかの表示トグルを揃える (家系図は 2026-07 に実装済み、タグを追加)

## スコープ外

- **認証・アクセス制御ではない**。Mado に認証は無く、防御は LAN / VPN 境界に委ねている (README / Favorites と同じオナーシステム契約)。この機能は **誤操作の防止** であって、悪意ある利用者を止めるものではない。誰でも Settings で権限を戻せる。
- ユーザ / ロール単位の権限。単位はあくまで接続。
- バケット単位・prefix 単位の権限。接続を分ければ表現できるので、粒度は増やさない。
- Mado 内メタデータ (タグ / 家系図リンク / お気に入り / チームノート) への権限。これらは Postgres にあり S3 を触らないので、権限の対象外。

## 権限の一覧

| キー | ラベル | 止まるエンドポイント |
| --- | --- | --- |
| `list` | バケット / オブジェクトの一覧 | `GET /storage/:connId/buckets`, `/list` |
| `preview` | ファイルのプレビュー (テキスト / 画像 / 音声) | `/preview/text`, `/preview/image`, `/preview/audio` |
| `download` | ファイルのダウンロード | `/preview/raw` |
| `archive` | 圧縮ファイル (tar / tar.gz / tar.xz) を開く | `/preview/tar`, `/preview/tar-entry` |
| `audioInfo` | 音声情報・波形の表示 | `/media/analyze` |
| `audioSpectrogram` | スペクトログラムの表示 | `/media/spectrogram` |
| `readmeRead` | README の読み込み | `GET /readme`, `/readme/history`, `/readme/history/:id`, `/readmes/search` |
| `readmeWrite` | README の編集 | `PUT /readme` |

補足:

- `list` を落とすと接続を登録した意味がほぼ無くなるので通常は触らないが、「完全に凍結した接続」を表現できるよう権限として持つ。
- README は Mado の DB ではなく **S3 上の `README.md` 実体**。したがって読み込み = `GetObject`、編集 = `PutObject` で、`preview` / `download` と同じ「本体を触る」系の操作にあたる。
- `readmeWrite` は `readmeRead` 必須。読み込めないまま PUT すると既存 README を丸ごと上書きするため。API は 400、UI は読み込みを切ると編集も自動で落ちる。
- `audioSpectrogram` は `audioInfo` に実質依存する (スペクトログラムは解析の副産物で、解析が走らなければ生成されない)。制約としては課さず、設定画面の説明文で伝える。

## データモデル

`storage_connections` に boolean カラムを足すのではなく、012 の `app_settings` と同じ **key/value** 形にする。権限は今後も増えるので、増えるたびに `ALTER TABLE` とマイグレーションの手当てをするのを避ける。

```sql
CREATE TABLE connection_settings (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, key),
  CHECK (length(key) BETWEEN 1 AND 64)
);
```

- **行が無い = 既定値**。権限の既定はすべて有効なので、テーブルが空ならマイグレーション適用前と挙動が一致し、既存接続へのバックフィルが要らない。
- key は `cap.<capability 名>` (`cap.download`, `cap.readmeWrite` …)。権限以外の接続別設定を将来足すときは別の名前空間を使う。
- value は TEXT。型の解釈はアプリ側 (`'false'` のときだけ無効)。
- トレードオフ: 「README 編集には読み込みが必要」のような組み合わせ制約は key/value では `CHECK` にできない。API 側 (`routes/connections.ts`) で 400 として弾き、UI でも組み合わせを作れないようにする。

読み出しは接続行と 1 往復にまとめる (`storage.ts` の `CONNECTION_SETTINGS_SUBQUERY`):

```sql
COALESCE((SELECT jsonb_object_agg(s.key, s.value)
            FROM connection_settings s
           WHERE s.connection_id = c.id), '{}'::jsonb) AS settings
```

`storage.ts` の接続キャッシュは S3Client と `ConnectionConfig` を同じ entry に持つので、権限もそこに同居する = リクエストごとの追加 DB アクセスは発生しない。接続を更新したら `invalidate()` でキャッシュを捨てる (**権限だけを変えた PUT でも捨てる**)。

## API

### 遮断: ミドルウェアで一括

ルートハンドラには権限の知識を持たせず、`internal.ts` でパスごとに mount する。「どのエンドポイントがどの権限に属するか」が 1 箇所で読める。

```ts
const cap = (k: Capability) => requireCapability(k, storageFactory.getConnectionConfig)
api.use('/storage/:connId/preview/raw', cap('download'))
// README は同じパスでメソッドごとに権限が違う
api.on('GET', '/storage/:connId/readme', cap('readmeRead'))
api.on('PUT', '/storage/:connId/readme', cap('readmeWrite'))
```

Hono は登録順に実行するので、**ルートの mount より前**に登録する。

レスポンスは `403 { error: "この接続では「ファイルのダウンロード」が無効になっています", capability: "download" }`。401 ではない — 認証の失敗ではなく「この接続では無効にされている」ため。接続が存在しなければ 404 を優先する。

### 設定: 接続 CRUD

`capabilities` を接続の入出力に足す。作成時は省略可 (全許可)、更新時は**差分** — 変えたトグルだけ送る。

接続行と `connection_settings` の 2 テーブルに書くので、POST / PUT はトランザクションにまとめる。権限の書き込みだけ失敗して「全権限が既定 (= 全部有効)」の接続が残る fail-open を避けるため。

## フロントエンド

`useCapabilities(connId)` で引く。取得経路は 2 つ:

- **Storage 配下** — `StoragePage` が既に接続を読んで `ConnectionContext` に入れているので、追加の fetch なしでそこから読む。
- **`BottomDock` のピン留めカード** — `<Routes>` の外に居て context が無く、しかも今開いている接続とは別の接続のファイルを表示しうる。この場合だけ接続一覧を取りに行く (セッション内でメモ化)。

**取得できるまでは全許可で描く**。実際の遮断は API が担うので、UI は楽観的でよい (押しても 403 になるだけ)。

隠す場所:

| 権限 | 隠すもの |
| --- | --- |
| `preview` | `PreviewDrawer` の本体 (テキスト / 画像 / 音声)、行メニューの「デッキに追加」 |
| `download` | `PreviewDrawer` / `PinnedPreviewCard` の DL、行メニューの「このファイルをダウンロード」 |
| `archive` | `PreviewDrawer` のアーカイブ本体、tar エントリの DL |
| `audioInfo` | `PreviewAudio` の解析呼び出しごと (呼ばなければフル DL も走らない) |
| `audioSpectrogram` | スペクトログラム画像 |
| `readmeRead` | `ReadmeView` セクションごと、`ReadmeSearchPanel` |
| `readmeWrite` | README の「編集 / 作成」リンク、`ReadmeEditPage` (URL 直打ちの受け皿) |

権限で閉じたプレビューは無言で空にせず理由を出す。無言だと「壊れている」と誤解されるため。Settings の接続一覧にも「制限: …」の行を出し、編集モーダルを開かなくても制限のかかった接続が分かるようにする。

## 機能の全体トグル

接続ごとの権限とは別物で、こちらは **単なる画面の出し分け** (S3 への操作は止めない)。`app_settings` に 1 行 = 1 機能で持ち、`useFeatureEnabled` (旧 `useLineageEnabled`) が読む。

- `lineage_enabled` — 家系図タブ (2026-07 実装済み)
- `tags_enabled` — タグバッジ / 絞り込み / タグ検索 / Settings のタグ管理 (今回追加)

どちらも「行が無い / `'false'` 以外」は有効。無効時は `?view=tags` / `?view=lineage` を直リンクされても一覧へ倒す (タブが無いのにビューが出ている迷子状態を作らない)。登録済みのタグ・家系図リンクは削除しない。

## マイグレーション

- `013_connection_settings.sql` — `connection_settings` テーブル
- `014_tags_enabled.sql` — `app_settings` に `tags_enabled = 'true'`

どちらも既存 DB へ手で再適用されうるので再実行可能に書く (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`)。運用中の DB への適用手順は `db/README.md` を参照。
