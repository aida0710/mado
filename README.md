# mado

研究室 LAN / VPN 内で使う内部ツール。**「窓」**の意。

S3 互換ストレージのバケットをブラウズ、各ディレクトリに README を読み書き、テキスト/画像/音声/tar(.gz / .xz) の中身を S3 クライアント無しでプレビュー。LAN 共有のメモ (`notes`) も付属。

スタックは Hono (TypeScript) + React + Vite + Postgres、Docker Compose で全サービス起動。

## 前提

- Docker + Docker Compose v2
- macOS / Linux で動作 (dev は macOS Docker Desktop を想定)
- LAN / VPN 内利用前提。インターネット公開は想定していない (詳細は [セキュリティモデル](#セキュリティモデル))

## クイックスタート

```bash
# 1. .env を用意
cp .env.example .env

# 2. ENCRYPTION_KEY を生成して .env に書く
openssl rand -hex 32   # ENCRYPTION_KEY

# 3. 起動
docker compose -f compose.dev.yaml up -d --build

# 4. ブラウザで http://localhost:5173
```

初回起動時のみ `db/init/00-init.sh` が `dashboard_rw` / `dashboard_ro` ロールと `dashboard_test` DB を作成する。再 init したいときは `down -v` で volume を消してから上げ直す。

## アーキテクチャ

dev / prod 共通で 3 サービス。dev は Vite dev server で HMR、prod は nginx で静的配信 + リバプロ。

```
                 ┌─ docker compose ──────────────────────────────┐
Browser ─:5173 ─►│ front (vite dev / dev)                        │
   または :80    │   または                                      │
                 │ nginx (静的 + リバプロ / prod)                │
                 │   │                                           │
                 │   └─► /api/internal/* → api-internal (Hono)   │
                 │                              │                │
                 │                          postgres             │
                 └───────────────────────────────────────────────┘
                 公開ポート: dev=5173 のみ / prod=80 のみ (LAN/VPN 経由前提)
```

| サービス | dev | prod |
|---|---|---|
| `front` | `vite dev` (HMR) | (なし、nginx に焼き込み) |
| `nginx` | (なし、Vite proxy が代替) | 静的配信 + `/api/internal/*` リバプロ |
| `api-internal` | `tsx watch internal.ts` | `node dist/internal.js` |
| `postgres` | postgres:16-alpine (`127.0.0.1:5432`) | postgres:16-alpine (compose 内部のみ) |

API 経路:
- `/api/internal/*` — ブラウザ向け (ストレージ参照 / 接続管理 / ノート)

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

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | yes | api コンテナの listen ポート (compose 側で 3000 に上書き) |
| `DATABASE_URL_RW` | yes | dashboard_rw 接続 URL。**compose 内なので host は `postgres`** |
| `DATABASE_URL_RO` | yes | dashboard_ro 接続 URL |
| `DATABASE_URL_RW_TEST` | no | テスト用。host から接続するので `localhost`。未設定なら同じ default を fallback |
| `ENCRYPTION_KEY` | yes | `storage_connections` テーブルに保存する S3 認証情報を AES-256-GCM で暗号化するキー (32 byte hex 必須) |
| `ALLOWED_ORIGINS` | yes | CSRF 防御。`/api/internal/*` の write 系で許容する Origin (カンマ区切り)。dev: `http://localhost:5173` / prod: ダッシュボードを開く URL |
| `PREVIEW_TEXT_LIMIT` | no | テキストプレビュー最大バイト (default 65536) |
| `PREVIEW_TAR_ENTRY_LIMIT` | no | tar 内 1 ページのエントリ最大数 (default 200) |
| `PREVIEW_TARXZ_BYTE_LIMIT` | no | tar.xz の解凍バイト上限 (default 256MiB) |

キー生成:
```bash
openssl rand -hex 32
```

## セキュリティモデル

このダッシュボードは **「LAN / VPN 境界に守られた研究室内ツール」** 前提で設計されている:

- **インターネットには出さない**。LAN / VPN に入っている限り、ブラウザ向け API (`/api/internal/*`) は **誰でも到達できる**。書き込み系 (connections / notes / favorites / readme) もすべて認証なし (オナーシステム)。
- 外部ホストからの ingest 経路 (旧 `/api/external/*` + Bearer token) は廃止済。あらゆる write は LAN / VPN 内からのみ。
- **`ENCRYPTION_KEY`** で `storage_connections` の S3 認証情報を保存時暗号化 (AES-256-GCM)。DB ダンプだけ漏れても解読不能。
- **CSRF 防御**: `/api/internal/*` の write 系 (POST/PUT/DELETE) は `ALLOWED_ORIGINS` と Origin/Referer を照合し、不一致なら 403。LAN 内に紛れた悪意あるページから write を撃たれる事故を防ぐ。
- **PG ロール分離**: アプリは `dashboard_rw` / `dashboard_ro` の 2 ロールを使い分け、ブラウザ由来の経路では Postgres レベルで `DROP TABLE` 等を防ぐ。`dashboard_rw` は `GRANT CREATE ON SCHEMA public` を持たない (新規テーブル作成不可)。

→ **このモデルが崩れる外部公開する場合は、最低限 `/api/internal/*` への認証層と `connections.endpoint` の SSRF 対策強化が必要**。詳細は [docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md) のスコープ外項目を参照。

## ディレクトリ構成

```
.
├── api/                  # Hono バックエンド (internal 1 entry)
│   ├── internal.ts       # /api/internal/* (browser 向け)
│   ├── routes/           # 各ルートハンドラ (相対パス、entry 側で prefix 付与)
│   ├── lib/              # tar-stream / tar-range
│   └── shared/           # zod schemas (frontend と共有想定、現状は空)
├── front/                # React + Vite (TypeScript)
│   ├── pages/            # HomePage, StoragePage, ConnectionsPage etc.
│   ├── components/
│   └── lib/api/          # API クライアント (API_BASE = '/api/internal')
├── nginx/                # prod 用 reverse proxy (multi-stage build)
├── db/                   # postgres init / migrations
├── docs/superpowers/     # spec / plan ドキュメント
├── compose.dev.yaml
└── compose.prod.yaml
```

## ドキュメント

- [元設計](docs/superpowers/specs/2026-04-30-web-dashboard-design.md) — 全体方針・脅威モデル・API 設計
- [現行 spec (P1+P3 統合)](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md) — front/back 分離・internal/external API 分割・Docker 化
- [実装プラン](docs/superpowers/plans/2026-05-02-p1-p3-merge.md)
- [`db/README.md`](db/README.md) — DB ロールとマイグレーション

## クレジット

- ロゴ (`front/public/mado-icon.png`): "Window" icon by [Inmotus Design](https://icons8.com/icon/set/window/external-others-inmotus-design) on [Icons8](https://icons8.com/)。Icons8 の無料利用規約により attribution を明記。
