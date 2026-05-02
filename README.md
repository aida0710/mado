# Web Dashboard

研究室 LAN 内で使う 2 ページの内部ツール。

- **メトリクス**: HPC ホスト (miyabi / 阪大 / その他) で動く `qstat` 等の出力を、ホスト × コマンドごとにカード一覧。各 HPC 側 cron が `POST /api/external/metrics/push` で送ってくる。
- **ストレージ**: S3 互換ストレージのバケットをブラウズ、各ディレクトリに README を読み書き、テキスト/画像/音声/tar(.gz / .xz) の中身を S3 クライアント無しでプレビュー。

スタックは Hono (TypeScript) + React + Vite + Postgres、Docker Compose で全サービス起動。

## 前提

- Docker + Docker Compose v2
- macOS / Linux で動作 (dev は macOS Docker Desktop を想定)
- LAN 内利用前提。インターネット公開は想定していない (詳細は [セキュリティモデル](#セキュリティモデル))

## クイックスタート

```bash
# 1. .env を用意
cp .env.example .env

# 2. WRITE_TOKEN と ENCRYPTION_KEY を生成して .env に書く
openssl rand -hex 32   # WRITE_TOKEN
openssl rand -hex 32   # ENCRYPTION_KEY

# 3. 起動
docker compose -f compose.dev.yaml up -d --build

# 4. ブラウザで http://localhost:5173
```

初回起動時のみ `db/init/00-init.sh` が `dashboard_rw` / `dashboard_ro` ロールと `dashboard_test` DB を作成する。再 init したいときは `down -v` で volume を消してから上げ直す。

## アーキテクチャ

dev / prod 共通で 4 サービス。dev は Vite dev server で HMR、prod は nginx で静的配信 + リバプロ。

```
                  ┌─ docker compose ────────────────────────────────────┐
Browser ─ :5173 ─►│ front (vite dev / dev)                              │
   または :80     │   または                                            │
                  │ nginx (静的 + リバプロ / prod)                      │
                  │   │                                                 │
External cron ────┼───┼──┐ /api/external/* ──► api-external (Hono :3001)│
                  │   │  │                                       │     │
                  │   └──┼─ /api/internal/* ──► api-internal (Hono :3000)│
                  │      │                                       │     │
                  │      └─────────────────► (静的: vite or dist) │     │
                  │                                               ▼     │
                  │                                          postgres   │
                  └─────────────────────────────────────────────────────┘
                  公開ポート: dev=5173 のみ / prod=80 のみ
```

| サービス | dev | prod |
|---|---|---|
| `front` | `vite dev` (HMR) | (なし、nginx に焼き込み) |
| `nginx` | (なし、Vite proxy が代替) | 静的配信 + `/api/*` リバプロ |
| `api-internal` | `tsx watch internal.ts` | `node dist/internal.js` |
| `api-external` | `tsx watch external.ts` | `node dist/external.js` |
| `postgres` | postgres:16-alpine (`127.0.0.1:5432`) | postgres:16-alpine (compose 内部のみ) |

API 経路:
- `/api/internal/*` — ブラウザ向け (ストレージ参照 / メトリクス読み取り / 接続管理 / ノート / 設定)
- `/api/external/metrics/push` — HPC cron 用 ingest (`WRITE_TOKEN` 認証)

詳細は [docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md)。

## 開発

### よく使うコマンド

```bash
docker compose -f compose.dev.yaml up -d         # 起動
docker compose -f compose.dev.yaml logs -f       # ログ追跡
docker compose -f compose.dev.yaml restart api-internal
docker compose -f compose.dev.yaml down          # 停止 (volume 残す)
docker compose -f compose.dev.yaml down -v       # 停止 + DB volume 削除
```

ソース変更は bind mount でコンテナに反映:
- `front/` → vite が HMR
- `api/` → `tsx watch` が再起動

### IDE 補完用に host でも npm install

コンテナの `node_modules` は anonymous volume に隔離してる (host との衝突回避) ので、PhpStorm 等で補完を効かせるには host 側でも install しておく:

```bash
cd front && npm install && cd ..
cd api && npm install && cd ..
```

### テスト

テストは host 上で直接 vitest を回す。postgres コンテナだけ立ち上がってれば良い:

```bash
docker compose -f compose.dev.yaml up -d postgres
cd api   && npm test
cd front && npm test
```

### Lint

```bash
cd api   && npm run lint
cd front && npm run lint
```

## 本番デプロイ

```bash
docker compose -f compose.prod.yaml up -d --build
```

dev との差分:
- nginx が `:80` (host) を listen して全トラフィックを受ける (api コンテナはホスト公開なし)
- api は image build 時の `tsc` 成果物 (`dist/`) を `node` で実行
- nginx と api は **non-root user** (nginx=uid 101, api=uid 1000) で動作
- 全コンテナが `restart: unless-stopped`

## HPC ホスト側 cron セットアップ

各 HPC ノードに `metrics/` 以下を配置して cron 登録:

```cron
*/5 * * * * DASHBOARD_URL=http://dashboard.lan WRITE_TOKEN=xxxxx /home/me/web-dashboard/metrics/example.py
```

- `metrics/db.py` が `urllib` で `${DASHBOARD_URL}/api/external/metrics/push?host=...&command=...&category=...` に POST
- body は raw stdout (text/plain)
- 詳細は `metrics/README.md` と `api/cron-samples/` を参照

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | yes | api コンテナの listen ポート (compose 側で 3000 / 3001 に上書き) |
| `DATABASE_URL_RW` | yes | dashboard_rw 接続 URL。**compose 内なので host は `postgres`** |
| `DATABASE_URL_RO` | yes | dashboard_ro 接続 URL |
| `DATABASE_URL_RW_TEST` | no | テスト用。host から接続するので `localhost`。未設定なら同じ default を fallback |
| `WRITE_TOKEN` | yes | `/api/external/metrics/push` の Bearer トークン (32 byte hex 必須) |
| `ENCRYPTION_KEY` | yes | `storage_connections` テーブルに保存する S3 認証情報を AES-256-GCM で暗号化するキー (32 byte hex 必須) |
| `PREVIEW_TEXT_LIMIT` | no | テキストプレビュー最大バイト (default 65536) |
| `PREVIEW_TAR_ENTRY_LIMIT` | no | tar 内 1 ページのエントリ最大数 (default 200) |
| `PREVIEW_TARXZ_BYTE_LIMIT` | no | tar.xz の解凍バイト上限 (default 256MiB) |

トークン / キーの生成:
```bash
openssl rand -hex 32
```

## セキュリティモデル

このダッシュボードは **「LAN 境界に守られた研究室内ツール」** 前提で設計されている:

- **インターネットには出さない**。LAN 内にいる限り、ブラウザ向け API (`/api/internal/*`) は **誰でも到達できる**。書き込み系 (connections / notes / settings / favorites / readme) もすべて認証なし (オナーシステム)。
- **`WRITE_TOKEN` は `/api/external/metrics/push` 専用**。HPC ホストの cron が外部から叩く唯一の経路を保護する。
- **`ENCRYPTION_KEY`** で `storage_connections` の S3 認証情報を保存時暗号化 (AES-256-GCM)。DB ダンプだけ漏れても解読不能。
- **PG ロール分離**: アプリは `dashboard_rw` / `dashboard_ro` の 2 ロールを使い分け、ブラウザ由来の経路では Postgres レベルで `DROP TABLE` 等を防ぐ。`dashboard_rw` は `GRANT CREATE ON SCHEMA public` を持たない (新規テーブル作成不可)。

→ **このモデルが崩れる外部公開する場合は、最低限 `/api/internal/*` への認証層と `connections.endpoint` の SSRF 対策強化が必要**。詳細は [docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md) のスコープ外項目を参照。

## ディレクトリ構成

```
.
├── api/                  # Hono バックエンド (internal / external 2 entry)
│   ├── internal.ts       # /api/internal/* (browser 向け)
│   ├── external.ts       # /api/external/metrics/push のみ (cron 向け)
│   ├── routes/           # 各ルートハンドラ (相対パス、entry 側で prefix 付与)
│   ├── lib/              # tar-stream / tar-range
│   ├── shared/           # zod schemas
│   └── cron-samples/     # 外部 cron 用 push スクリプト雛形
├── front/                # React + Vite (TypeScript)
│   ├── pages/            # HomePage, MetricsPage, StoragePage, ConnectionsPage etc.
│   ├── components/
│   └── lib/api/          # API クライアント (API_BASE = '/api/internal')
├── nginx/                # prod 用 reverse proxy (multi-stage build)
├── db/                   # postgres init / migrations
├── metrics/              # 外部 HPC ホスト cron に置く Python スクリプト
├── docs/superpowers/     # spec / plan ドキュメント
├── compose.dev.yaml
└── compose.prod.yaml
```

## ドキュメント

- [元設計](docs/superpowers/specs/2026-04-30-web-dashboard-design.md) — 全体方針・脅威モデル・API 設計
- [現行 spec (P1+P3 統合)](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md) — front/back 分離・internal/external API 分割・Docker 化
- [実装プラン](docs/superpowers/plans/2026-05-02-p1-p3-merge.md)
- [`db/README.md`](db/README.md) — DB ロールとマイグレーション
- [`metrics/README.md`](metrics/README.md) — HPC 側 cron スクリプトの導入方法
