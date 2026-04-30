---
title: Web Dashboard 設計（スパコン + mdx S3）
date: 2026-04-30
status: draft
authors: aida
---

# Web Dashboard 設計

研究室の LAN 内で使う、2 ページの内部ツールを作る。

- **スパコンページ**: miyabi / 阪大 / その他 HPC で動く `qstat` などのコマンド出力を集めて、ホスト × コマンドごとにカードで一覧表示する。
- **mdx S3 ページ**: mdx 上の S3 バケットをブラウズし、各ディレクトリに README.md を読み書きでき、テキスト/画像/音声/tar 系の中身プレビューができる。

このドキュメントはアーキテクチャ・データ・API・画面・運用方針を含む。実装計画（タスク分解）は別途 plan で扱う。

## 目的と非目的

### 目的
- 研究室メンバーが、HPC の混み具合を 1 画面で把握できる。
- mdx S3 のバケット構造を視覚的にブラウズできる。
- 各ディレクトリに「ここに何があるか」を README で残せる。
- 大きい tar/tar.gz/tar.xz のエントリ一覧、テキスト/画像/音声の中身を、S3 クライアントを立ち上げずに確認できる。

### 非目的（明示的に作らない）
- HPC メトリクスの構造化処理（ソート、フィルタ、グラフ）。後から `/sql/write` で別テーブルを足して回避する。
- S3 への書き込み機能全般（README 以外）。delete / rename / upload は作らない。
- 認証・ユーザ管理。LAN 内の信頼前提に乗る。
- 外部公開・SSO・監査ログ・E2E テスト。

## 利用前提と脅威モデル

- LAN 内（研究室）で稼働。インターネットには出さない。
- 利用者は数人、相互に信頼関係あり。
- README の「最終更新者」は自己申告（honor system）。改ざんされうるが運用上許容。
- ダッシュボードに到達できる人 = mdx S3 全バケットを閲覧できる人。これは設計上の仕様であり、防御は LAN 境界で行う。
- 守るのは「うっかり壊す」だけ。具体的には:
  - フロントから `DROP TABLE` などができないこと（PG のロール分離で強制）。
  - 探索ボットやクライアント側の事故から書き込みエンドポイントを守ること（Bearer トークン）。

## 全体構成

単一ホストで Hono + Postgres + 静的フロントエンドを動かす。HPC 側からは PUSH 型でメトリクスが届く。

```
┌─────────── LAN ────────────────────────────────────────┐
│                                                         │
│  Browser (研究室の数人) ──────────────► Dashboard host │
│                                          ┌────────────┐ │
│  HPC cron                                │ Hono       │ │
│  (miyabi / 阪大 / ...)                    │  - static  │ │
│  qstat | curl ─Bearer─► /api/hpc/push ──►│  - /api/*  │ │
│                                          │  - /sql/wt │ │
│                                          └─────┬──────┘ │
│                                                ▼        │
│                                          ┌────────────┐ │
│                                          │ Postgres   │ │
│                                          └────────────┘ │
└──────────────────────────────────────┬──────────────────┘
                                       │
                                       ▼  S3 SDK
                                ┌──────────────┐
                                │   mdx S3     │
                                └──────────────┘
```

### 技術スタック

- フロント: React 19 + TypeScript + Vite（既存テンプレ）
- バックエンド: Node.js + Hono
- DB: Postgres（同一ホスト）
- S3 クライアント: `@aws-sdk/client-s3`
- アーカイブ: `tar-stream`、Node 標準 `zlib`（gzip）、xz 解凍ライブラリ（`@napi-rs/lzma` または `lzma-native`、Node のバージョンに合うもの）
- ランタイム検証: `zod`
- テスト: Vitest（バックエンド中心）

### プロセスモデル

- 開発: `npm run dev` で Vite dev (5173) と Hono (3000) を並列。Vite は `/api/*` と `/sql/*` を 3000 に proxy。
- 本番: `npm run build` → `dist/` を Hono の `serveStatic` で配信 + API。`node server/index.js` 1 プロセス。

## ディレクトリ構成

```
web-dashboard/
├── src/                            # フロント（Vite + React）
│   ├── pages/
│   │   ├── HpcPage.tsx
│   │   └── S3Page.tsx
│   ├── components/
│   │   ├── HpcCard.tsx
│   │   ├── S3Browser.tsx
│   │   ├── ReadmeView.tsx
│   │   ├── ReadmeEditor.tsx
│   │   ├── PreviewText.tsx
│   │   ├── PreviewImage.tsx
│   │   ├── PreviewAudio.tsx
│   │   └── PreviewArchive.tsx
│   ├── api/                        # fetch ラッパ
│   ├── App.tsx, main.tsx, index.css
│
├── server/                         # Hono バックエンド
│   ├── index.ts                    # エントリ
│   ├── env.ts                      # 環境変数読込・検証（zod）
│   ├── db.ts                       # pg Pool 2 つ（rw / ro）
│   ├── s3.ts                       # S3 クライアント
│   ├── auth.ts                     # Bearer 検証ミドルウェア
│   ├── routes/
│   │   ├── hpc.ts                  # GET /api/hpc, POST /api/hpc/push
│   │   ├── sql.ts                  # POST /sql/write
│   │   ├── s3-list.ts              # GET /api/s3/list
│   │   ├── s3-readme.ts            # GET/PUT /api/s3/readme
│   │   └── s3-preview.ts           # GET /api/s3/preview/{text,image,audio,tar}
│   ├── lib/
│   │   ├── tar-stream.ts           # tar/tar.gz/tar.xz 共通エントリ列挙
│   │   └── range.ts                # Range header → S3 GetObject
│   ├── shared/                     # フロントと共有する型（zod schemas）
│   └── cron-samples/               # HPC 側 cron に置く参考スクリプト
│
├── docs/superpowers/specs/         # この設計ドキュメント
├── index.html
├── vite.config.ts                  # /api と /sql を proxy
├── package.json
└── tsconfig*.json
```

`server/shared/` の zod スキーマは、フロントの fetch ラッパと server の routes の両方が import する。これで API のレスポンス型がズレない。

## データモデル

`hpc_metrics` は固定スキーマを置かず、コマンド標準出力を生テキストとして貯める方針。ホストごとにスケジューラ（PBS, SLURM, Fujitsu pjstat 等）が違うため、構造化は諦め「どこで・何コマンドを・いつ叩いた結果か」だけタグ付けする。

```sql
CREATE TABLE hpc_metrics (
  id           BIGSERIAL   PRIMARY KEY,
  host         TEXT        NOT NULL,    -- 'miyabi' / 'osaka' / 'fugaku' …
  command      TEXT        NOT NULL,    -- 'qstat' / 'pjstat' / 'squeue' / 'df' …
  output       TEXT        NOT NULL,    -- 標準出力をそのまま
  exit_code    INTEGER,                 -- 任意。失敗時の検知用
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hpc_metrics_host_command_collected
       ON hpc_metrics(host, command, collected_at DESC);

-- (host, command) ごとに最新の 1 件だけ拾うビュー
CREATE VIEW hpc_metrics_latest AS
SELECT DISTINCT ON (host, command) *
FROM   hpc_metrics
ORDER  BY host, command, collected_at DESC;

-- S3 README のメタ情報。本文は S3 上の README.md にある。
CREATE TABLE s3_readme_meta (
  bucket          TEXT        NOT NULL,
  prefix          TEXT        NOT NULL,   -- 'a/b/' 形式（バケット直下は ''）
  last_editor     TEXT        NOT NULL,   -- 自己申告
  last_edited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  size_bytes      INTEGER,
  PRIMARY KEY (bucket, prefix)
);
```

### Postgres ロール

```sql
CREATE ROLE dashboard_rw LOGIN PASSWORD '...';
CREATE ROLE dashboard_ro LOGIN PASSWORD '...';
GRANT  ALL    ON ALL TABLES IN SCHEMA public TO dashboard_rw;
GRANT  SELECT ON ALL TABLES IN SCHEMA public TO dashboard_ro;
ALTER  DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_ro;
```

`/sql/write` と `/api/hpc/push` は `dashboard_rw` の Pool を使う。`/api/*` の読み取り系は `dashboard_ro` の Pool を使う。これで「フロント由来の経路が DROP TABLE をできない」ことを Postgres レベルで保証する。

`s3_readme_meta` の更新は「本文 PUT が S3 で成功したあとに UPSERT」する。S3 PUT が失敗したら DB は触らない。逆順だと「メタは新しいのに本文は古い」状態が生じうる。

## API 設計

### 共通

- ベース URL: 同一オリジン。
- 認証: 書き込み系のみ `Authorization: Bearer ${WRITE_TOKEN}`。読み取り系は LAN 内信頼前提で認証なし。
- エラーフォーマット: `{ "error": "<message>" }` を 4xx で返す。

### HPC

| メソッド | パス | 認証 | 役割 |
|---|---|---|---|
| `POST` | `/api/hpc/push?host=...&command=...` | `WRITE_TOKEN` | 標準入力 (text/plain) を受け取り、`hpc_metrics` に INSERT |
| `GET` | `/api/hpc` | なし | `hpc_metrics_latest` を JSON で返す |

`POST /api/hpc/push` は `Content-Type: text/plain` の生 body をそのまま `output` に入れる。`exit_code` は本エンドポイントでは渡せない（pipeline の都合上 `qstat | curl` 形では失われる）。記録したいときは `/sql/write` で直接 INSERT する。HPC 側 cron の典型は:

```bash
qstat | curl -sS -X POST \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary @- \
  "http://dashboard/api/hpc/push?host=miyabi&command=qstat"
```

`GET /api/hpc` は次のような JSON 配列を返す:

```json
[
  { "host": "miyabi", "command": "qstat",
    "output": "...", "collected_at": "2026-04-30T12:34:56Z" },
  { "host": "osaka",  "command": "pjstat",
    "output": "...", "collected_at": "2026-04-30T12:34:50Z" }
]
```

### 汎用 SQL（書き込みのみ）

| メソッド | パス | 認証 | 役割 |
|---|---|---|---|
| `POST` | `/sql/write` | `WRITE_TOKEN` | 任意の SQL を `dashboard_rw` で実行する逃げ道 |

リクエスト:

```json
{ "sql": "INSERT INTO foo(...) VALUES ($1, $2)", "params": ["a", 42] }
```

レスポンス:

```json
{ "rowCount": 1 }                       // 行を返さない文
{ "rows": [...] }                       // RETURNING や SELECT を含む場合
```

エラーは Postgres の文字列をそのまま透過する:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{ "error": "relation \"foo\" does not exist" }
```

「読み取り用の汎用エンドポイント」（`/sql/read`）は **作らない**。フロントは semantic API のみを使う。アドホック SELECT は psql で叩くか、必要になったら同じ形で `/sql/read` を読み取りロールで増設する。

### S3

| メソッド | パス | 認証 | 役割 |
|---|---|---|---|
| `GET` | `/api/s3/buckets` | なし | アカウントから見えるバケット一覧（S3 `ListBuckets`） |
| `GET` | `/api/s3/list?bucket=...&prefix=...&continuation=...` | なし | prefix 配下の一覧（`ListObjectsV2` を `Delimiter='/'` で呼び、`CommonPrefixes` を `directories` に、`Contents` を `files` に整形） |
| `GET` | `/api/s3/readme?bucket=...&prefix=...` | なし | README 本文（S3）+ メタ（DB）を合成して返す |
| `PUT` | `/api/s3/readme` | なし（honor system） | 本文を S3 に PUT、メタを DB に UPSERT |
| `GET` | `/api/s3/preview/text?bucket=...&key=...` | なし | 先頭 `PREVIEW_TEXT_LIMIT` バイトを `text/plain` で返す |
| `GET` | `/api/s3/preview/image?bucket=...&key=...` | なし | 画像を proxy で返す |
| `GET` | `/api/s3/preview/audio?bucket=...&key=...` | なし | Range header を S3 へ転送する proxy |
| `GET` | `/api/s3/preview/tar?bucket=...&key=...&limit=...` | なし | tar / tar.gz / tar.xz のエントリ一覧（path, size）を JSON で返す |

`/api/s3/list` は次の形:

```json
{
  "directories": ["raw/", "cleaned/"],
  "files": [
    { "key": "voice/jp/README.md", "size": 2148, "lastModified": "..." },
    ...
  ],
  "nextContinuation": "..." | null
}
```

`PUT /api/s3/readme` のリクエスト:

```json
{
  "bucket": "datasets-2024",
  "prefix": "voice/jp/",
  "body": "# Voice JP dataset\n...",
  "editor": "tanaka"
}
```

README ファイルのキーは `${prefix}README.md` で組む（`prefix` は末尾 `/` 付き、バケット直下は空文字）。サーバ側の処理順:

1. S3 へ `PutObject({ Bucket: bucket, Key: prefix + 'README.md', Body: body, ContentType: 'text/markdown' })`。失敗したら DB は触らず 5xx。
2. 成功したら `s3_readme_meta` に `(bucket, prefix, editor, now(), size)` を UPSERT。
3. レスポンス: `{ "ok": true, "size_bytes": N }`.

`/api/s3/preview/audio` は Range header を S3 GetObject へ素直に転送する。これで `<audio>` 要素のスクラブ（シーク）が動く。S3 が LAN 外でも一旦サーバを通すので CORS は出ない。

`/api/s3/preview/tar` は内部で:

- `tar` → そのまま `tar-stream`
- `tar.gz` → `zlib.createGunzip()` → `tar-stream`
- `tar.xz` → xz 解凍ストリーム → `tar-stream`

エントリは `limit`（既定 `PREVIEW_TAR_ENTRY_LIMIT`）件で打ち切る。`tar.xz` は加えて生バイト数 `PREVIEW_TARXZ_BYTE_LIMIT` で打ち切る。

## フロントエンド

### ルーティング

- `/` → スパコンページ
- `/s3` → S3 ルート（バケット一覧）
- `/s3/:bucket` → バケット直下
- `/s3/:bucket/*` → サブディレクトリ

ページ切替は上部ヘッダのタブ（`[スパコン]` `[mdx S3]`）。サイドバーは作らない。

### スパコンページ

- `GET /api/hpc` を初回ロードと「⌥ refresh」ボタンで叩く。
- レスポンスを `(host, command)` の組ごとに `HpcCard` で並べる。並びは `host` 昇順、二段目 `command` 昇順。
- カード本体は `<pre>` の monospace。長いときは `max-height` でスクロール。
- 「最終更新からの経過時間」を `collected_at` から計算してサブタイトルに出す。

### S3 ページ

- 上部にパンくず（`bucket / a / b /`）。各セグメントクリックで遡る。
- メイン領域に `S3Browser`（ディレクトリ → ファイルの順）。Prev/Next とページ番号表示。
- リストの下に `ReadmeView`。README が無いディレクトリでは「README なし — ✎ create」プレースホルダ。
- ファイル拡張子で MIME を判定し、クリックで右ドロワに対応するプレビューコンポーネント（`PreviewText`/`PreviewImage`/`PreviewAudio`/`PreviewArchive`）を出す。
- 編集者名は `localStorage["dashboard.lastEditor"]` に保存して次回プリフィル。

### MIME 判定（簡易）

| 拡張子 | プレビュー |
|---|---|
| `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv`, `.log` | text |
| `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` | image |
| `.mp3`, `.wav`, `.flac`, `.ogg` | audio |
| `.tar`, `.tar.gz`, `.tgz`, `.tar.xz` | archive |
| その他 | 「プレビュー非対応」+ Download リンク |

## エラー処理

- API の失敗は `{ "error": "..." }` + 4xx/5xx。フロントはインラインバナー or トースト。
- `/sql/write` は PG エラーをそのまま透過するため、文言が英語のままになる。これは仕様（事故調査の手がかりを増やす）。
- フロントは zod でレスポンスを軽くバリデーション。型ズレは画面に「unexpected response shape」を出して落ちないようにする。
- 5xx で連発する場合のバックオフ・リトライは作らない（手動 refresh で十分）。

## ロギング

- Hono の logger ミドルウェアで request log を stdout。
- `/sql/write` は受け取った SQL 全文を別ロガー名で stdout に書く（`logger.sql`）。事故調査のため。
- ファイルへ書かない。systemd journal なり PM2 なりで拾う。

## 設定

`server/env.ts` で `process.env` を zod で検証する。欠損は起動時に fail-fast。

| 名前 | 既定 | 説明 |
|---|---|---|
| `PORT` | 3000 | Hono のリスンポート |
| `DATABASE_URL_RW` | — | `dashboard_rw` の接続文字列 |
| `DATABASE_URL_RO` | — | `dashboard_ro` の接続文字列 |
| `WRITE_TOKEN` | — | 書き込み API の Bearer |
| `S3_ENDPOINT` | — | mdx S3 のエンドポイント URL |
| `S3_REGION` | `auto` | S3 SDK 用 |
| `S3_ACCESS_KEY_ID` | — | |
| `S3_SECRET_ACCESS_KEY` | — | |
| `PREVIEW_TEXT_LIMIT` | 65536 | テキストプレビューの最大バイト数 |
| `PREVIEW_TAR_ENTRY_LIMIT` | 200 | tar 系プレビューの最大エントリ数 |
| `PREVIEW_TARXZ_BYTE_LIMIT` | 268435456 | tar.xz の decompress 上限（256MB） |

`.env` で運用、`.gitignore` に入れる。`.env.example` を同梱。

## ビルドと開発

```jsonc
// package.json scripts (抜粋)
{
  "dev:web": "vite",
  "dev:server": "tsx watch server/index.ts",
  "dev": "concurrently -k -n web,server -c blue,magenta \"npm:dev:web\" \"npm:dev:server\"",
  "build:web": "tsc -b && vite build",
  "build:server": "tsc -p server/tsconfig.json",
  "build": "npm run build:web && npm run build:server",
  "start": "node server/dist/index.js"
}
```

`vite.config.ts` に `/api` と `/sql` の proxy を追加する。

## テスト

Vitest をバックエンド中心に。

- `server/lib/tar-stream.test.ts`: 固定フィクスチャ（`tar`, `tar.gz`, `tar.xz`）でエントリ列挙が `limit` で止まる。
- `server/auth.test.ts`: トークンなし / 誤りで 401。
- `server/routes/hpc.test.ts`: 一時 PG（同マシンの test スキーマ）で `POST /api/hpc/push` → `GET /api/hpc` のラウンドトリップ。
- `server/db.test.ts`: RW Pool が CREATE TABLE できる、RO Pool が CREATE TABLE で permission denied になることを assertion。
- フロントは Vitest + RTL を `ReadmeEditor` の保存フローだけ。残りは目視。
- E2E は作らない。

## 残課題・将来の検討

- README の鍵名: `README.md` 固定で実装するが、読み取り時に `readme.md` フォールバックを許すかは初回実装後に判断。
- HPC 履歴: 必要になったら `hpc_metrics` を遡って表示するページを足す。今は最新 1 行のみ。
- メトリクス TTL: `hpc_metrics` は無限に肥大化する。30 日で削除する pg_cron を将来入れる候補（今回は対象外）。
- `/sql/read` を読み取り専用 Pool で生やすか: フロントから生 SELECT を打ちたくなったら検討。
- HPC `command` ホワイトリスト: 現在は任意文字列を許す。`/^[a-z0-9_-]+$/` 程度の制約は実装時に検討。
