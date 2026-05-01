---
title: P1+P3 統合: front/back 分離 + internal/external API 分割 (Hono 継続)
date: 2026-05-02
status: planning
authors: aida
supersedes_decisions_in: docs/superpowers/specs/2026-05-01-front-back-separation-roadmap.md
---

# P1+P3 統合設計

## 背景

`docs/superpowers/specs/2026-05-01-front-back-separation-roadmap.md` で、front / back の段階的分離を P1 → P2 → P3 の 3 フェーズに分けることにした。本セッション (2026-05-02) で方針見直しを行い、以下に変更:

- **P2 (FastAPI 移行) は中止**。Hono (TypeScript) のまま続行する。
- **P1 と P3 を本 spec に統合**。front/back 分離と internal/external API 分割を 1 度に行う。

理由は **「dev と prod を同じ vite dev で済ませる」案を一度検討したが、配信担当 (Hono / nginx) と動作モード (vite dev / build) を兼ねさせると責任が混ざってかえって複雑になる**ため、最初からコンポーネントを 1 ジョブずつに分けたほうが見通しがよい。それを実現するなら、API 分割 (P3) も同時に入れたほうが nginx の設定が一度で済むので統合する。

---

## 決定事項 (2026-05-02)

| 項目 | 決定 | 備考 |
|---|---|---|
| スコープ | **roadmap P1 + P3 を統合**、**P2 中止** | Hono 継続 |
| 言語 | **Hono (TypeScript)** 据置 | 言語移行は将来的にも実施しない方針 |
| リポ構造 | **単一リポ、root `package.json` 削除** | front/ と api/ が独立した npm プロジェクトに |
| 環境 | **`compose.dev.yaml` と `compose.prod.yaml` を分ける** | dev は HMR、prod は nginx 静的配信 |
| 配信 (dev) | **Vite dev server (`:5173`)** | コンテナ内で `--host 0.0.0.0`、Vite proxy で API 振り分け |
| 配信 (prod) | **nginx (`:80`)** | `front/dist` を nginx image に焼き、`/api/internal/*` `/api/external/*` を upstream に流す |
| API 分割 | **`api-internal:3000` と `api-external:3001` を別プロセス・別コンテナ** | 同一コードベース、entry が 2 つ |
| API パス命名 | **`/api/internal/*` と `/api/external/*`** | 既存パスは破壊的変更で全部書き換え |
| `/sql/*` 扱い | **`/api/internal/sql/*` に統合** | `/sql/write` も `/sql/read` も移行 |
| Token | **単一 `WRITE_TOKEN` 据置** | `INGEST_TOKEN` / `ADMIN_TOKEN` 分割は別 spec |
| ホスト公開 | **dev: `5173` のみ / prod: `80` のみ** | api コンテナは内部ネットに閉じる (bind 制限不要) |
| Healthcheck | postgres は据置、api は `depends_on` で代用 | コンテナ自身の `/healthz` は監視ツール側で叩く想定 |

---

## 全体アーキテクチャ

### Dev のフロー

```
Browser ─── http://localhost:5173 ──▶ front (vite dev)
                                          │ Vite proxy
                                          ▼
                      ┌── /api/internal/* ──▶ api-internal:3000 ─┐
                      └── /api/external/* ──▶ api-external:3001 ─┤
                                                                  ▼
                                                              postgres:5432
```

- 公開ポートは `5173` のみ。`api-internal:3000` と `api-external:3001` は compose 内部ネットワークに閉じる。
- Vite proxy が browser からの `/api/*` リクエストを compose ネットワーク内のサービス名で振り分け。
- 外部 cron は dev では使わない。

### Prod のフロー

```
Browser ──┐
          ├── http://lab-server:80 ──▶ nginx ──┬─ / ──────────────▶ /usr/share/nginx/html (静的)
External  │                                    ├─ /api/internal/* ─▶ api-internal:3000
cron      │                                    └─ /api/external/* ─▶ api-external:3001
─────────-┘                                                                   │
                                                                              ▼
                                                                          postgres:5432
```

- 公開ポートは `80` のみ。すべての外部からのトラフィックは nginx を通る。
- 外部スパコンの cron は `http://lab-server/api/external/metrics/push` を叩く (api-external コンテナを直接ホスト公開しない)。

---

## ディレクトリ構造

```
web-dashboard/
├── compose.dev.yaml            # 開発用: postgres + api-internal + api-external + front (vite dev)
├── compose.prod.yaml           # 本番用: postgres + api-internal + api-external + nginx
├── .env.example                # 共通の env 例 (DATABASE_URL_RW/RO, ENCRYPTION_KEY, WRITE_TOKEN, etc.)
│
├── api/
│   ├── package.json            # 独立した npm プロジェクト
│   ├── Dockerfile              # node:22-bookworm-slim、両 entry 共用
│   ├── tsconfig.json
│   ├── internal.ts             # 新規: internal app の entry
│   ├── external.ts             # 新規: external app の entry
│   ├── env.ts / db.ts / crypto.ts / storage.ts / auth.ts   # 据置 (両 entry が import)
│   ├── lib/                    # 据置
│   ├── shared/                 # 据置 (zod schemas)
│   ├── cron-samples/           # external 用 cron スクリプト見本 (URL 更新が必要)
│   └── routes/
│       ├── metrics.ts          # 分割: mountMetricsReadRoutes (internal) と mountMetricsPushRoutes (external)
│       ├── sql.ts              # internal 専用 (`/api/internal/sql/*` で mount)
│       ├── storage-list.ts     # internal 専用
│       ├── storage-readme.ts   # internal 専用
│       ├── storage-preview.ts  # internal 専用
│       ├── storage-favorites.ts # internal 専用
│       ├── connections.ts      # internal 専用
│       ├── notes.ts            # internal 専用
│       └── settings.ts         # internal 専用
│
├── front/
│   ├── package.json            # 独立した npm プロジェクト
│   ├── Dockerfile              # 開発専用: node:22-alpine、`vite dev --host 0.0.0.0`
│   ├── vite.config.ts          # proxy ターゲットを compose ネット内のサービス名に
│   ├── lib/api/                # `API_BASE = '/api/internal'` 定数を導入し、全 fetch を集約
│   └── ... (既存)
│
├── nginx/
│   ├── Dockerfile              # multi-stage: front の vite build → /usr/share/nginx/html、設定ファイルを焼く
│   └── default.conf            # / → 静的、/api/internal/* → api-internal:3000、/api/external/* → api-external:3001
│
├── db/                         # 据置 (init / migrations)
├── metrics/                    # 据置 (外部スパコンに置く参考スクリプト、URL 更新が必要)
├── docs/                       # 据置
│
├── package.json                # 削除 (workspaces 解体)
├── package-lock.json           # 削除
└── eslint.config.js            # 削除 (front/ と api/ それぞれに移植)
```

---

## コンポーネント詳細

### `api-internal`

- **Entry**: `api/internal.ts`
- **公開ポート**: `3000` (compose 内部ネットワークのみ)
- **マウント**: 全 routes を `/api/internal/*` 配下に
  - `/api/internal/metrics` (read)
  - `/api/internal/sql/write` (要 `WRITE_TOKEN`)
  - `/api/internal/sql/read`
  - `/api/internal/storage/list/...`
  - `/api/internal/storage/readme`
  - `/api/internal/storage/preview/...`
  - `/api/internal/storage/favorites`
  - `/api/internal/connections/...`
  - `/api/internal/notes/...`
  - `/api/internal/settings`
- **prefix 外のルート**: `GET /healthz` (healthcheck 用)
- **共有依存**: `env`, `db (pools)`, `crypto`, `storageFactory`, `auth` を import

### `api-external`

- **Entry**: `api/external.ts`
- **公開ポート**: `3001` (compose 内部ネットワークのみ)
- **マウント**: `POST /api/external/metrics/push` のみ (要 `WRITE_TOKEN`)
- **prefix 外のルート**: `GET /healthz`
- **共有依存**: `env`, `db (rw pool)` のみ。`crypto` `storage` は不要

### `front` (dev のみ)

- vite dev server をコンテナ内で `--host 0.0.0.0 --port 5173` で起動
- ソースは bind mount (`./front:/app`)、`/app/node_modules` のみ anonymous volume で host と分離
- IDE 補完用に host 側でも `npm install` を別途回す

### `nginx` (prod のみ)

- Multi-stage Dockerfile:
  1. `node:22-alpine` ステージで `front/` の `npm ci && npm run build` → `/front/dist`
  2. `nginx:alpine` ステージで `/front/dist` を `/usr/share/nginx/html` にコピー、`default.conf` を焼く
- 設定の概形:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }

    location /api/internal/ {
        proxy_pass http://api-internal:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location /api/external/ {
        proxy_pass http://api-external:3001;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 2m;
    }
}
```

- `proxy_buffering off` は storage-preview の大きいレスポンスのため。
- `client_max_body_size 2m` は metrics push の body size 上限を nginx 側でも明示。

### Vite proxy 設定

```typescript
// front/vite.config.ts
server: {
  host: true,
  proxy: {
    '/api/internal': 'http://api-internal:3000',
    '/api/external': 'http://api-external:3001',
  },
}
```

- path は preserve (Hono 側で `/api/internal/*` `/api/external/*` を mount している)。
- compose 内部の DNS で `api-internal` `api-external` を解決。

### Hono の mount 方法

```typescript
// api/internal.ts (概形)
const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const api = new Hono()
mountMetricsReadRoutes(api, { pools })
mountSqlRoutes(api, { pools, writeToken: env.WRITE_TOKEN })
mountConnectionsRoutes(api, { pools, crypto, invalidate: storageFactory.invalidate })
mountStorageListRoutes(api, { getStorage: storageFactory.getStorage })
mountStorageReadmeRoutes(api, { getStorage: storageFactory.getStorage, pools })
mountStoragePreviewRoutes(api, { getStorage: storageFactory.getStorage, env })
mountStorageFavoritesRoutes(api, { pools })
mountNotesRoutes(api, { pools })
mountSettingsRoutes(api, { pools })

app.route('/api/internal', api)
serve({ fetch: app.fetch, port: 3000 }, ...)
```

```typescript
// api/external.ts (概形)
const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

const api = new Hono()
mountMetricsPushRoutes(api, { pools, writeToken: env.WRITE_TOKEN })

app.route('/api/external', api)
serve({ fetch: app.fetch, port: 3001 }, ...)
```

---

## API パスの全変更 (破壊的変更)

| 現状 | 新 |
|---|---|
| `GET /api/metrics` | `GET /api/internal/metrics` |
| `POST /api/metrics/push` | **`POST /api/external/metrics/push`** |
| `POST /sql/write` | `POST /api/internal/sql/write` |
| `POST /sql/read` | `POST /api/internal/sql/read` |
| `GET /api/storage/list/...` | `GET /api/internal/storage/list/...` |
| `GET /api/storage/readme` | `GET /api/internal/storage/readme` |
| `PUT /api/storage/readme` | `PUT /api/internal/storage/readme` |
| `GET /api/storage/preview/...` | `GET /api/internal/storage/preview/...` |
| `GET /api/storage/favorites` (etc.) | `GET /api/internal/storage/favorites` |
| `GET/POST /api/connections/...` | `GET/POST /api/internal/connections/...` |
| `GET/PUT /api/notes/...` | `GET/PUT /api/internal/notes/...` |
| `GET/PUT /api/settings` | `GET/PUT /api/internal/settings` |
| `GET /healthz` | (各 app の root に残す、prefix 外) |

---

## コード変更サマリ

### 削除

| ファイル | 理由 |
|---|---|
| `package.json` (root) | workspaces 解体 |
| `package-lock.json` (root) | 同上 |
| `eslint.config.js` (root) | front/ と api/ それぞれに移植 |
| `api/index.ts` | `internal.ts` + `external.ts` に置き換え |
| `compose.yml` | `compose.prod.yaml` にリネーム |

### 新規

| ファイル | 役割 |
|---|---|
| `compose.dev.yaml` | postgres + api-internal + api-external + front |
| `compose.prod.yaml` | postgres + api-internal + api-external + nginx |
| `api/Dockerfile` | node:22-bookworm-slim、`lzma-native` 用 build deps を含む |
| `api/internal.ts` | internal app entry |
| `api/external.ts` | external app entry |
| `front/Dockerfile` | dev 専用、vite dev コンテナ |
| `nginx/Dockerfile` | multi-stage、front build → nginx に焼く |
| `nginx/default.conf` | reverse proxy + static 設定 |

### 修正

- **`api/routes/metrics.ts`** — `mountMetricsRoutes` を **`mountMetricsReadRoutes`** (internal) と **`mountMetricsPushRoutes`** (external) に分割
- **`api/package.json`** — scripts を `dev:internal` / `dev:external` / `start:internal` / `start:external` / `build` / `test` / `test:watch` に
- **`front/vite.config.ts`** — proxy ターゲットを `http://api-internal:3000` / `http://api-external:3001` に
- **`front/lib/api/*`** — `const API_BASE = '/api/internal'` を 1 箇所定義し、全 fetch を `${API_BASE}/...` に
- **`api/routes/*.test.ts`** — テストの URL を新 prefix に追従 (sub-app を prefix なしでテストする方針なら多くは無変更で済む見込み)
- **`metrics/example.py`** + **`api/cron-samples/`** — push エンドポイントを `/api/external/metrics/push` に
- **`docs/superpowers/specs/2026-05-01-front-back-separation-roadmap.md`** — 末尾に追記: 「2026-05-02 に方針変更: P2 中止、P1+P3 を本 spec に統合」

---

## 移行順序 (実装プラン作成時に詳細化)

1. **API 分割の準備** — `api/routes/metrics.ts` を `mountMetricsReadRoutes` / `mountMetricsPushRoutes` に分割。既存 `api/index.ts` がまだ動く状態を維持。
2. **`internal.ts` / `external.ts` を新規追加** — 既存 `index.ts` から bootstrap 部分をコピー、それぞれの entry で適切な routes をマウント。
3. **Front の API コール書き換え** — `API_BASE` 定数導入と全 fetch 書き換え。`/sql/*` も `/api/internal/sql/*` に。
4. **テスト更新** — 必要な箇所のみ。
5. **`api/Dockerfile` 追加 + `front/Dockerfile` 追加 + `compose.dev.yaml` 追加** — `docker compose -f compose.dev.yaml up` で dev 環境動作確認。
6. **`nginx/Dockerfile` + `nginx/default.conf` 追加 + `compose.prod.yaml` 追加** — `docker compose -f compose.prod.yaml up` で prod 環境動作確認。
7. **workspaces 解体** — root の `package.json` / `package-lock.json` / `eslint.config.js` 削除、front/ と api/ にそれぞれ eslint config を持たせる。
8. **古い `api/index.ts` 削除**。
9. **外部スクリプトの URL 更新** — `metrics/example.py` と `api/cron-samples/`。
10. **`compose.yml` を `compose.prod.yaml` にリネーム** (もしくは削除して prod 用を新規作成)。
11. **roadmap doc に追記** — P2 中止、P1+P3 を本 spec に統合。

---

## テスト方針

| レイヤ | 方針 |
|---|---|
| **既存 unit テスト** (`api/routes/*.test.ts`) | sub-app に prefix なしで mount しているテスト方針を維持すれば、ほとんど変更不要。絶対パスを叩いている箇所のみ更新 |
| **`metrics.test.ts`** | 関数分割 (`mountMetricsReadRoutes` / `mountMetricsPushRoutes`) に追従 |
| **新規テスト** | 不要 (API surface の責任分配のみで、新しい振る舞いは追加されない) |
| **Smoke test** | `docker compose -f compose.dev.yaml up` で立ち上げて `curl` で疎通確認、までは手動 |
| **Lint** | front/ と api/ それぞれの `eslint.config.js` で `npm run lint` が通ること |

---

## スコープ外

| 項目 | 理由 |
|---|---|
| FastAPI 移行 (旧 P2) | 本セッションで中止決定 |
| `INGEST_TOKEN` / `ADMIN_TOKEN` 分割 | 単一 `WRITE_TOKEN` 据置 |
| bind 制限 (`127.0.0.1` / LAN CIDR) | api コンテナを host に公開しない方針のため不要 |
| TLS / HTTPS | LAN 内ツール、対象外 |
| 認証システム追加 (cookie session / OIDC / basic auth) | roadmap に従い対象外 |
| `/sql/*` の削除 | 「将来課題」として roadmap・ヘルプモーダル spec に記載済み。今回は移すだけ |
| i18n / メトリクス TTL env 化 / 収集スクリプト全面見直し / フロント大規模 refactor | roadmap に従い対象外 |
| CI/CD パイプライン | 手動 `docker compose up` 運用、CI 投資は YAGNI |
| 本番デプロイ手順書 | `docker compose -f compose.prod.yaml up -d` が手順そのもの |
| compose healthcheck (api 側) | postgres は据置、api は `depends_on` で十分 |

---

## 影響範囲 (運用作業)

P1+P3 完了時に**コードベース外で必要になる作業**:

- **外部スパコンに既にデプロイされている cron スクリプト** — push エンドポイントを `/api/metrics/push` から `/api/external/metrics/push` に書き換える運用作業。これは P1+P3 のリリース時に手動で対応する。
- **既存ブックマークやドキュメント** — 旧 `/api/...` URL を貼ってる箇所があれば書き換え (該当数は少ない見込み)。

---

## 関連ドキュメント

- `docs/superpowers/specs/2026-04-30-web-dashboard-design.md` — リポジトリ全体の元設計
- `docs/superpowers/specs/2026-05-01-front-back-separation-roadmap.md` — 元の 3 フェーズ ロードマップ。本 spec は P1+P3 を統合し、P2 を中止する形で上書きする
- `docs/superpowers/specs/2026-05-01-metrics-help-modal-design.md` — 同日確定のヘルプモーダル設計。「サーバー分離 / トークン分割」を将来課題と明記。本 spec で前者を回収、後者は引き続き将来課題

---

## 次セッション

本 spec が承認され次第、`superpowers:writing-plans` で実装プランを作成する。プラン作成時の追加検討事項:

- `lzma-native` の Dockerfile 内ビルド (Alpine では build-essential が必要、Debian slim ベースに切り替えるかどうか)
- compose の `env_file` 経路 (`.env` をプロジェクトルートに置き、両 api サービスが共有する)
- IDE (PhpStorm) からの補完用に host 側で `npm install` を別途回すルール
- `vite.config.ts` の proxy ターゲットを env 変数化するか (現状は compose ネットワーク内の hostname を hard-code する想定)
- nginx image の build 戦略 (front を nginx image に焼く vs バインドマウントで dist を渡す)
- front / api 各サブディレクトリでの eslint 設定の最小構成
