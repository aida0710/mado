# 一覧レスポンスのサーバー側キャッシュ

## 背景

`mdx` 接続の `dataset` バケットは、ディレクトリ一覧が **35 秒**かかる。

計測で分かっていること (2026-08-17):

| 条件 | 実測 |
| --- | --- |
| `dataset` root、Delimiter あり (ダッシュボード) | 35.2 秒 |
| `dataset` root、Delimiter あり (s3cmd) | 35.96 秒 |
| `dataset`、Delimiter なし (再帰検索) | 0.095 秒 |
| `max-keys` を 100 / 既定 1000 に変えた場合 | 差なし |
| 他バケット、Delimiter あり | 0.04〜0.39 秒 |

原因はバケットのキー数で、`dataset` は **547,259 キー / 903 TB**。S3 互換実装が `/` でのグルーピング (CommonPrefixes) を線形走査で処理しているため、コストは「返す件数」ではなく「バケット全体のキー数」に比例する。1 キーあたり約 64 マイクロ秒。s3cmd も同じ時間がかかるので、**アプリ側に改善余地はない**。prefix を絞っても走査量が減らないため一定。

クライアント側は既に stale-while-revalidate 化されている (`87773de`)。ただしキャッシュは **localStorage = ブラウザごと**なので、次の場合に 35 秒を再び払う:

- 別の人が初めて開いたとき
- 別の端末・別のブラウザから開いたとき
- ブラウザのストレージを消したとき
- クライアント TTL (6 時間) が切れたとき

研究室で複数人が同じバケットを見る使い方では、この 35 秒が人数分・端末数分だけ発生している。

## 目的

- **応答をサーバー側で共有する**。誰か一人が開けば、以降は全員・全端末が速い
- 35 秒を払う頻度を「ブラウザごとに 6 時間に 1 回」から「**全体で 24 時間に 1 回**」にする
- 新しいミドルウェア (Redis 等) を増やさない。既に立っている Postgres を使う

## スコープ外

- **プリウォーム**。「誰も 35 秒を待たない」状態にするには、`media_jobs` / `media-worker` に定期再取得をさせる必要がある。効果は大きいが、温める対象の選定とスケジューリングの設計が要るので本仕様には含めない。導線は残す (「将来の拡張」参照)
- **サーバー側の stale-while-revalidate**。素直な hard TTL にする。上と同じ理由
- `readme` のキャッシュ。0.4 秒と速く、かつアプリ内から書き換わる唯一の対象なので、無効化経路を増やす割に得るものが小さい
- `preview` / `tar` / `media` 系。本仕様は一覧のみを対象にする
- **バケットの構造改善**。`debug/` (162,447 キー / 5.6 TB) と `vibevoice-cache/` (137,757 キー / 40.7 TB) の 2 つでキー数の 55% を占めており、退避すれば 35 秒は 16 秒程度まで落ちる。ただし実データの移動判断は本仕様の対象外

## なぜ Redis ではなく Postgres か

Redis が効くのは「サブミリ秒のレイテンシ」「秒間数千リクエスト」「メモリ上での大量エビクション」が要る場面。本件は LAN 内の研究室ダッシュボードで、同時利用者は数人、キャッシュ対象は 1 ページ数 KB の JSON。実際に閲覧されるページ数を多めに見ても数百件、**総量は 10 MB 未満**で、Postgres が気づく規模ではない。

一方で Postgres は既に立っており、**既にキャッシュとして使われている**。`db/migrations/006_media.sql` の `media_cache` は `cache_key = sha256(JSON([...]))` を主キーに JSONB を持つ設計で、`api/lib/media-cache.ts` の `getCachedMedia` / `upsertMediaCache` がそのまま雛形になる。

Redis を足すと、コンテナが 1 つ増え、永続化方針 (RDB/AOF か揮発か) を決める必要が生じ、`compose.prod.yaml` と `.env` が増え、落ちたときの縮退動作を書く必要が出る。2026-08-17 に本番ホストのディスクを使い切ってデプロイが停止した経緯を踏まえ、運用対象は増やさない。

TTL も `expires_at TIMESTAMPTZ` 列と読み出し時の条件で足りる。

## 対象エンドポイント

| エンドポイント | 対象 | 理由 |
| --- | --- | --- |
| `GET /storage/:connId/list` | ○ | 35 秒の当事者 |
| `GET /storage/:connId/buckets` | ○ | 純粋な S3 読み取りで、アプリ内から変更されない |
| `GET /storage/:connId/readme` | × | 0.4 秒と速く、`PUT /readme` で書き換わる |

## スキーマ

`db/migrations/016_storage_response_cache.sql`:

```sql
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

`cache_key` は `sha256(JSON([kind, connId, bucket, prefix, recursive, continuation, startAfter]))` の hex。`kind` は `'list'` か `'buckets'`。

**`conn_id` / `bucket` / `prefix` を別カラムでも持つ理由**: ハッシュだけでは「この prefix の全ページ」をまとめて消せない。1 つの prefix は cursor 違いで複数行になるため、prefix 単位の無効化にはカラムでの絞り込みが要る。クライアント側の `invalidatePrefix` と同じことをサーバーでも行う。

`list_objects_version` はキーに含めない。接続設定の変更時に `conn_id` 単位で全削除するため (「無効化」参照)。

### ロールについての判断

キャッシュの書き込みは GET リクエスト上で起きるため、読み取り経路が `dashboard_rw` を触ることになる。「ブラウザ由来の読み取り経路は `dashboard_ro` を使い、Postgres レベルで `DROP TABLE` 等を防ぐ」という既存の設計思想がここで緩む。

専用ロール `dashboard_cache` (当該テーブルへの `SELECT` / `INSERT` / `UPDATE` / `DELETE` のみ) を切るのが筋だが、ロール作成は `db/init/00-init.sh` にあり **ボリューム初回作成時にしか実行されない**。稼働中の本番 DB には手動 `CREATE ROLE` と `.env` への資格情報追加が必要になる。この種の手作業は、ローカル dev DB の `dashboard_rw` パスワード不整合 (2026-08-18 時点で未解消) と同じドリフトを生む。

**判断**: `dashboard_rw` を使う。書き込み先が `storage_response_cache` の 1 テーブルに限られることを `api/lib/storage-cache.ts` のコメントに明記する。将来ロールを分ける場合は、`00-init.sh` と稼働中 DB への適用手順をセットで用意する。

## TTL

- サーバー: **24 時間**
- クライアント: 現状の 6 時間のまま (`LONG_CACHE_TTL_MS`)

二段になるが役割が違う。クライアントは「即座に描画する」ため、サーバーは「35 秒を全体で 1 回に減らす」ため。クライアントが 6 時間で stale になっても、再検証はサーバーキャッシュに当たって 0.1 秒で終わる。

## 強制リフレッシュ

現在 `api.list()` の `force` フラグは 2 つの意味で使われている。**サーバーキャッシュ導入にあたり、これを分離する。**

| 用途 | 呼び出し元 | クライアントキャッシュ | サーバーキャッシュ |
| --- | --- | --- | --- |
| ページ送り (cursor stuck 対策) | `StorageBrowser.next()` | 迂回する | **迂回しない** |
| `↻` ボタン | `StorageBrowser.forceRefresh()` | 破棄する | **貫通する** |

混ぜると「次へ」を押すたびに S3 まで行き、`dataset` では 1 ページ送るのに 35 秒かかる。

`↻` のときだけ API に `refresh=1` を送る。サーバーはこのパラメータがあればキャッシュを読まず、S3 から取得した結果で行を上書きする。

この経路が無いと、ユーザーは最大 24 時間 古いデータから逃げられない。`↻` の貫通は必須。

## 無効化

| 契機 | 削除範囲 |
| --- | --- |
| `PUT /storage/:connId/readme` | `conn_id` + `bucket` + `prefix` に一致する行 (README.md が一覧に現れるため) |
| `PUT /connections/:id` | `conn_id` の全行 (endpoint や `list_objects_version` の変更で応答が変わる) |
| `DELETE /connections/:id` | `conn_id` の全行 |
| ダッシュボード外での操作 (aws cli 等) | 検知不能。TTL の担当 |

このダッシュボードが一覧を変える S3 書き込みは `PUT /readme` だけである (favorites / tags / notes / settings / connections はすべて Postgres 内で完結する)。そのため無効化の経路は最小で済む。

## 失敗時の縮退

**キャッシュはリクエストを壊さない。**

- 読み出し失敗 → ログを残して S3 へ行く
- 書き込み失敗 → ログを残して応答はそのまま返す
- 期限切れ行を読んだ → その行を削除して S3 へ行く

`api/lib/media-cache.ts` およびクライアント側 localStorage の「失敗は silent」と同じ思想。

## 期限切れ行の掃除

定期ジョブは置かない。行は `cache_key` で UPSERT されるので、同じページを再訪すれば上書きされ、増加は「閲覧された異なるページ数」で頭打ちになる。

読み出し時に期限切れ行を明示的に削除することはしない。miss と判定した後に S3 から取り直して UPSERT すれば同じ行が上書きされるため、削除は冗長な書き込みになるだけである。読み出しの SQL は `expires_at > now()` で弾くので、期限切れ行が返ることはない。

二度と訪れないページの行は残るが、1 行あたり数 KB なので実害はない。数百 MB 規模まで育つようなら定期 `DELETE FROM storage_response_cache WHERE expires_at < now()` を `media-worker` に足す。

## 実装の配置

- `api/lib/storage-cache.ts` (新規) — `cacheKey()` / `getCached()` / `upsertCache()` / `invalidateScope()` / `invalidateConnection()`
- `api/routes/storage-list.ts` — `/list` と `/buckets` でキャッシュを引く。Pool は直接渡さず、既存の `StorageListDeps` に沿ってキャッシュ操作のインターフェースを注入する (既存のルートテストが fake の deps を組み立てる方式を崩さないため)
- `api/routes/storage-readme.ts` — `PUT` 後に `invalidateScope()`
- `api/routes/connections.ts` — 更新・削除後に `invalidateConnection()`
- `front/lib/api/client.ts` — `refresh` オプションを追加し、`force` とは別に送る
- `front/components/StorageBrowser.tsx` — `forceRefresh()` だけが `refresh: true` を渡す。ページ送りは従来どおり `force` のみ
- `front/pages/StorageIndex.tsx` — バケット一覧の `↻` (`forceRefresh()`) も `api.buckets(connId, { refresh: true })` を渡す。`/list` と同じ理由で、貫通しないと 24 時間逃げられなくなる

## テスト

- `api/lib/storage-cache.test.ts` — hit / miss / 期限切れ / prefix 単位の無効化 / conn 単位の無効化
- `api/routes/storage-list.test.ts` — fake キャッシュを注入し、hit のとき S3 を呼ばないこと、`refresh=1` のとき hit を無視して S3 を呼ぶこと、キャッシュが例外を投げても応答が返ること
- `front/components/StorageBrowser.test.tsx` — `↻` は `refresh: true`、ページ送りは `force: true` かつ `refresh` なしで呼ぶこと

## 受け入れ確認

デプロイ後、本番で以下を実測する。

1. `list?bucket=dataset` の 1 回目 — 約 35 秒 (S3 まで行く)
2. 同 2 回目 — **0.1 秒台** (キャッシュ hit)
3. 別ブラウザ / localStorage を消した状態で開く — 0.1 秒台
4. `↻` を押す — 約 35 秒 (貫通している)
5. 「次へ」を押す — キャッシュがあれば 0.1 秒台 (貫通していない)
6. 速いバケット (`trash` 等) に退行がないこと

## 既知の制約

**同時アクセスは重複して S3 を叩く。** クライアント側の `TTLCache` は同一キーの in-flight リクエストを 1 本に集約するが、サーバー側にはその仕組みがない。二人が同時に `dataset` を初めて開くと、二人とも 35 秒を払い、S3 へのリクエストも 2 本出る。

本仕様では対処しない。理由は 3 つ:

- 利用者が数人の研究室ダッシュボードで、35 秒の窓に二人が入る確率は低い
- 重複しても壊れない。遅いだけで、後から書いた方が勝つだけ
- サーバー側の in-flight 集約は、プロセス内 Map (api コンテナが 1 つなら足りる) か Postgres のアドバイザリロックのどちらかになる。どちらも本題の共有キャッシュとは別の関心事で、必要になってから足す方が判断しやすい

実際に重複が問題になるようなら、`pg_advisory_xact_lock(hashtext(cache_key))` で 1 本に絞るのが素直。

## 将来の拡張

- **プリウォーム**: `media_jobs` と `media-worker` は既にある。よく見る prefix を定期的に取り直せば、TTL 切れの瞬間をユーザーが引き当てる構造自体をなくせる
- **サーバー側 SWR**: 期限切れの行を返しつつ裏で取り直す。クライアント側と同じ考え方で、35 秒を誰も待たなくなる
- **専用 DB ロール**: 上記「ロールについての判断」を参照
