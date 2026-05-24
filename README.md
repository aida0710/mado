# mado

研究室 LAN / VPN 内で使う内部ツール。**「窓」** の意。

S3 互換ストレージのバケットを **S3 クライアント無しでブラウズ・プレビュー** できる Web ダッシュボードです。各ディレクトリに README を残したり、チームで 1 つの共有ノートを書いたりもできます。

<!-- 📸 docs/img/hero.png — Storage 画面の全体 (左にファイル一覧、右にプレビュー)。README トップ用のヒーロー画像 -->

## できること

- **横断ブラウズ** — 複数の S3 互換ストレージ (接続) を登録し、バケット / ディレクトリを辿る
- **プレビュー** — テキスト / 画像 / 音声 / `tar`・`tar.gz`・`tar.xz` の中身を、ダウンロードせずその場で確認
- **URL コピー** — ファイルの Web URL (共有リンク) / S3 URL / ダウンロードをワンクリック
- **ディレクトリ README** — 各ディレクトリに Markdown のメモを残せる (履歴つき)
- **チーム共有ノート** — Mado 全体で 1 つの Markdown メモ (履歴つき)

---

## 使い方

> スクリーンショットは `docs/img/` に置く想定です。各所の `<!-- 📸 ... -->` が貼り場所、
> まとめは末尾の [スクリーンショットの追加場所](#スクリーンショットの追加場所) を参照。

### アクセス

研究室 LAN / VPN 内から、ダッシュボードの URL をブラウザで開きます (URL は管理者に確認。例: `http://<ホスト>/`)。**ログインはありません** (LAN / VPN 境界が前提 → [セキュリティ](#セキュリティ))。

上部のタブで **Home / Storage / Settings** を切り替えます。

<!-- 📸 docs/img/masthead.png — 上部のロゴ "mado." と Home / Storage / Settings タブ -->

### 1. ストレージ接続を登録する (Settings)

初回は接続が無いので、まず **Settings → 「+ 追加」** で S3 互換ストレージを登録します。

- **名前** — 一覧での表示名
- **エンドポイント / リージョン**
- **アクセスキー / シークレットキー** — 保存時に暗号化されます ([セキュリティ](#セキュリティ))
- **path-style / ListObjects バージョン** — 互換ストレージに合わせて選択

登録した接続は後から編集・削除できます。

<!-- 📸 docs/img/connection-form.png — Settings の「+ 追加」を押したときの入力フォーム -->

### 2. バケット / ディレクトリをブラウズする (Storage)

**Storage** タブで接続を選びます (登録が 1 つだけなら自動で開きます)。

- ディレクトリをクリックして潜る / パンくずで戻る
- 上部の検索ボックスで **前方一致** 検索 (再帰検索オプションあり)
- 一覧が多いときは下部のページャでめくる

<!-- 📸 docs/img/browser.png — ファイル一覧 + 検索ボックス + パンくず -->

### 3. ファイルをプレビューする

ファイルの行をクリックすると **右側にプレビュー** が開きます (テキスト / 画像 / 音声)。

- プレビューの **左端の境界をドラッグ** して幅を調整できます (リストを圧縮せず上に重なる形で広がる)。変更した幅は記憶され、ヘッダの **`↔`** で既定幅に戻せます
- ヘッダの **DL** で元ファイルをダウンロード
- テキスト / JSON は **「内容をコピー」** で全文をクリップボードへ

<!-- 📸 docs/img/preview.png — 右ドロワーで JSON をプレビュー (左端の幅調整ハンドルが分かる構図) -->

### 4. tar / tar.gz / tar.xz の中身を見る

アーカイブを開くと **中のエントリ一覧** が表示されます。エントリをクリックすると個別にプレビュー (テキスト / 画像 / 音声) でき、テキストは **「内容をコピー」** で全文コピーできます。

<!-- 📸 docs/img/tar.png — tar のエントリ一覧、およびエントリを開いたプレビュー -->

### 5. URL コピー / ダウンロード

各行の **`⋯` メニュー** から:

- **Web URL をコピー** — そのファイルのプレビューを直接開く共有リンク (LAN / VPN 内の相手に渡せる)
- **S3 URL をコピー** — `s3://バケット/キー`
- **このファイルをダウンロード**

<!-- 📸 docs/img/copy-menu.png — 行の ⋯ メニューを開いた状態 -->

### 6. ディレクトリごとの README

各ディレクトリの上部に **S3 README** が表示されます。**編集** (✎) で Markdown を書き、**履歴** (⏱) で過去の版を確認できます。長い README は折りたたまれ、「すべて表示」で展開します。

<!-- 📸 docs/img/readme.png — ディレクトリ上部の S3 README 表示 + 編集/履歴ボタン -->

### 7. チーム共有ノート (Home)

**Home** は Mado 全体で 1 つの **Team note** (Markdown)。メンバー全員で追記していく共有メモで、**編集** / **履歴** が使えます。

<!-- 📸 docs/img/home-note.png — Home の Team note 表示 -->

### バージョン確認

**Settings** の一番下 **About** に、バージョン・稼働中のコミット (GitHub リンク) ・リポジトリが表示されます。

---

## セットアップ (管理者向け)

### 前提

- Docker + Docker Compose v2
- macOS / Linux (dev は macOS Docker Desktop を想定)
- LAN / VPN 内利用前提。インターネット公開は想定していない ([セキュリティ](#セキュリティ))

### クイックスタート (dev)

```bash
# 1. .env を用意
cp .env.example .env

# 2. ENCRYPTION_KEY を生成して .env に書く (32 byte hex)
openssl rand -hex 32

# 3. 起動 (--build はコミット情報を About に焼くため初回 / 更新時に推奨)
docker compose -f compose.dev.yaml up -d --build

# 4. ブラウザで http://localhost:5173
```

dev の DB パスワードは未設定なら既定値 (`postgres` / `CHANGEME`) で動きます。初回起動時のみ `db/init/00-init.sh` が `dashboard_rw` / `dashboard_ro` ロールと `dashboard_test` DB を作成します。作り直したいときは `down -v` で volume を消してから上げ直してください。

### 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | yes | api コンテナの listen ポート (compose 側で 3000 に上書き) |
| `DATABASE_URL_RW` | yes | `dashboard_rw` 接続 URL。**compose 内なので host は `postgres`** |
| `DATABASE_URL_RO` | yes | `dashboard_ro` 接続 URL |
| `DATABASE_URL_RW_TEST` | no | テスト用。host から接続するので `localhost`。未設定なら default に fallback |
| `POSTGRES_PASSWORD` | prod:yes / dev:no | `postgres` スーパーユーザのパスワード。**prod は未設定だと起動失敗**、dev は既定 `postgres` |
| `DASHBOARD_PASSWORD` | prod:yes / dev:no | `dashboard_rw` / `dashboard_ro` のパスワード。**`DATABASE_URL_*` のパスワードと一致必須**。dev 既定 `CHANGEME` |
| `ENCRYPTION_KEY` | yes | `storage_connections` の S3 認証情報を AES-256-GCM で暗号化するキー (32 byte hex) |
| `ALLOWED_ORIGINS` | yes | CSRF 防御。write 系で許容する Origin (カンマ区切り)。dev: `http://localhost:5173` / prod: ダッシュボードを開く URL |
| `PREVIEW_TEXT_LIMIT` | no | テキストプレビュー最大バイト (default 65536) |
| `PREVIEW_TAR_ENTRY_LIMIT` | no | tar 内 1 ページのエントリ最大数 (default 200) |
| `PREVIEW_TARXZ_BYTE_LIMIT` | no | tar.xz の解凍バイト上限 (default 256MiB) |

> ⚠️ `POSTGRES_PASSWORD` / `DASHBOARD_PASSWORD` は **DB ボリュームの初回作成時のみ** 反映されます。既存 DB のパスワード変更は env ではなく `psql` の `ALTER ROLE` が必要です (詳細は [`db/README.md`](db/README.md))。生成例: `openssl rand -hex 24`

### 本番デプロイ

```bash
./deploy.sh   # main を pull し、compose.prod.yaml で再ビルド + 再起動
```

`deploy.sh` は稼働中コミットを About に焼くため git 情報を build に渡します。dev との差分:

- nginx が `:80` (host) を listen し全トラフィックを受ける (api コンテナはホスト非公開)
- api は image build 時の `tsc` 成果物 (`dist/`) を `node` で実行
- nginx と api は **non-root user** で動作
- 全コンテナが `restart: unless-stopped`
- **prod は `POSTGRES_PASSWORD` / `DASHBOARD_PASSWORD` が `.env` に無いと起動しません** (弱い既定値の埋め込み防止)

---

## セキュリティ

このダッシュボードは **「LAN / VPN 境界に守られた研究室内ツール」** 前提で設計されています:

- **インターネットには出さない**。LAN / VPN 内であればブラウザ向け API は誰でも到達でき、書き込み系も認証なし (オナーシステム)。
- **`ENCRYPTION_KEY`** で `storage_connections` の S3 認証情報を保存時暗号化 (AES-256-GCM)。DB ダンプだけ漏れても解読不能。
- **CSRF 防御**: write 系 (POST/PUT/DELETE) は `ALLOWED_ORIGINS` と Origin/Referer を照合し、不一致なら 403。
- **PG ロール分離**: ブラウザ由来の経路は `dashboard_rw` / `dashboard_ro` を使い分け、Postgres レベルで `DROP TABLE` 等を防ぐ。

→ **外部公開する場合は、最低限 `/api/internal/*` への認証層と `connections.endpoint` の SSRF 対策が必要**。詳細は [docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md) のスコープ外項目を参照。

---

## 開発者向け

### アーキテクチャ

dev / prod 共通で 3 サービス。dev は Vite dev server で HMR、prod は nginx で静的配信 + リバプロ。

```
                 ┌─ docker compose ──────────────────────────────┐
Browser ─:5173 ─►│ front (vite dev / dev)                        │
   または :80    │   または                                      │
                 │ nginx (静的 + リバプロ / prod)                │
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

### よく使うコマンド

```bash
docker compose -f compose.dev.yaml up -d --build   # 起動 (About のコミット表示には --build)
docker compose -f compose.dev.yaml logs -f         # ログ追跡
docker compose -f compose.dev.yaml down            # 停止 (volume 残す)
docker compose -f compose.dev.yaml down -v         # 停止 + DB volume 削除
```

ソース変更は bind mount で反映: `front/` → vite HMR / `api/` → `tsx watch` 再起動。

### IDE 補完用に host でも install

```bash
cd front && npm install && cd ..
cd api   && npm install && cd ..
```

### テスト / Lint

host 上で直接実行 (postgres コンテナだけ立っていれば良い):

```bash
docker compose -f compose.dev.yaml up -d postgres
cd api   && npm test && npm run lint
cd front && npm test && npm run lint
```

### ディレクトリ構成

```
.
├── api/                  # Hono バックエンド (internal 1 entry)
│   ├── internal.ts       # /api/internal/* (browser 向け)
│   ├── routes/           # 各ルートハンドラ
│   └── lib/              # tar-stream / tar-range
├── front/                # React + Vite (TypeScript)
│   ├── pages/            # HomePage, StoragePage, ConnectionsPage etc.
│   ├── components/
│   └── lib/              # API クライアント / buildInfo / hooks
├── nginx/                # prod 用 reverse proxy (multi-stage build)
├── db/                   # postgres init / migrations
├── docs/                 # spec / plan / 画像 (docs/img/)
├── compose.dev.yaml
└── compose.prod.yaml
```

### ドキュメント

- [元設計](docs/superpowers/specs/2026-04-30-web-dashboard-design.md) — 全体方針・脅威モデル・API 設計
- [現行 spec (P1+P3 統合)](docs/superpowers/specs/2026-05-02-p1-p3-merge-design.md)
- [`db/README.md`](db/README.md) — DB ロール / マイグレーション / パスワードのローテーション

---

## スクリーンショットの追加場所

`docs/img/` に PNG を置き、本文中の対応する `<!-- 📸 ... -->` を `![説明](docs/img/ファイル名.png)` に置き換えてください (`docs/img/` が無ければ作成)。

| ファイル | 撮る内容 | 貼る場所 |
|---|---|---|
| `hero.png` | Storage 全体 (一覧 + 右プレビュー) | 冒頭 |
| `masthead.png` | 上部タブ (Home/Storage/Settings) | 使い方 > アクセス |
| `connection-form.png` | 接続追加フォーム | 使い方 1 |
| `browser.png` | 一覧 + 検索 + パンくず | 使い方 2 |
| `preview.png` | 右プレビュー + 幅調整ハンドル | 使い方 3 |
| `tar.png` | tar のエントリ一覧 / エントリプレビュー | 使い方 4 |
| `copy-menu.png` | 行の `⋯` メニュー展開 | 使い方 5 |
| `readme.png` | ディレクトリの S3 README | 使い方 6 |
| `home-note.png` | Home の Team note | 使い方 7 |

> 撮影は接続を 1 つ登録した状態で、実データのうち公開して問題ないバケット / ファイルを選んでください (鍵・バケット名など秘匿情報が写り込まないように)。

---

## クレジット

- ロゴ (`front/public/mado-icon.png`): "Window" icon by [Inmotus Design](https://icons8.com/icon/set/window/external-others-inmotus-design) on [Icons8](https://icons8.com/)。Icons8 の無料利用規約により attribution を明記。
