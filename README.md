# mado

複数のs3アカウントと多数のバケットを横断的に管理することを目的に開発したwebツール。

各ディレクトリに README を残したり、チームで 1 つの共有ノートを書いたりもできます。

<img width="1340" height="771" alt="mosaic_20260524162904" src="https://github.com/user-attachments/assets/4f5349ad-38c2-46c7-8e29-3be76477615c" />

Local UserまたはOIDC SSOでログインでき、Pipelineは人とは別のService Account keyを使います。既存LAN運用から移行できるよう認証無効モードも残していますが、外部公開では使用しません。

## できること

- **横断ブラウズ** — 複数の S3 互換ストレージ (接続) を登録し、バケット / ディレクトリを辿る
- **プレビュー** — テキスト / 画像 / 音声 / MP4動画 / `tar`・`tar.gz`・`tar.xz` の中身を、ダウンロードせずその場で確認
- **URL コピー** — ファイルの Web URL (共有リンク) / S3 URL / ダウンロードをワンクリック
- **ディレクトリ README** — 各ディレクトリに Markdown のメモを残せる (履歴つき)
- **チーム共有ノート** — Mado 全体で 1 つの Markdown メモ (履歴つき)
- **波形 / スペクトログラム** — 音声ファイルの波形とスペクトログラムをその場で確認 (解析結果はキャッシュ)
- **同期プレイヤー** — 複数の音声ファイルを並べて同期再生し聴き比べる
- **配下の集計** — ディレクトリ配下のオブジェクト数と合計サイズを数える (サブディレクトリ / 拡張子別の内訳つき)
- **容量メトリクス** — コネクション内の全バケットの容量・オブジェクト数と合計を定期取得し、Rechartsで増減を確認
- **移送の見積もり** — その集計をもとに「他の接続へ移したら費用と時間はどれくらいか」を並べて比較。AWS S3 はストレージクラスも選べる
- **接続ごとの権限** — 「一覧は見せるがダウンロードと README 書き戻しは禁止」のように、接続単位で操作を絞れる
- **Dataset Lineage** — OpenLineageの`Dataset → Job → Dataset`と、版ごとの`DatasetVersion → Run → DatasetVersion`をReact Flowで辿る
- **認証とRBAC** — Local User / OIDC SSO、Viewer・Curator・Operator・Admin、監査ログ
- **Pipeline API key** — namespaceを限定したService Account keyを一度だけ表示して発行

---

### アクセス

ダッシュボードのURLをブラウザで開き、SSOまたは管理者が作成したLocal Userでログインします。`AUTH_MODE=disabled`の既存LAN環境ではログイン画面を出しません。

上部のタブで **Home / Storage / Settings** を切り替えます。

<img width="1176" height="90" alt="image" src="https://github.com/user-attachments/assets/9cf6a372-5b78-4adf-beee-0feb2ba28987" />

### 1. ストレージ接続を登録する (Settings)

初回は接続が無いので、まず **Settings → 「+ 追加」** で S3 互換ストレージを登録します。

- **名前** — 一覧での表示名
- **エンドポイント / リージョン**
- **アクセスキー / シークレットキー** — 保存時に暗号化されます ([セキュリティ](#セキュリティ))
- **path-style / ListObjects バージョン** — 互換ストレージに合わせて選択
- **ユーザーからの表示** — 通常は全員、例外だけホワイトリストで利用者を限定
- **この接続で許可する操作** — 危険な導線を接続単位で閉じられます (下記)

登録した接続は後から編集・削除でき、Storage タブが開くデフォルト接続もここで変更できます。

#### ユーザーからの表示

接続は既定でログイン済みの全ユーザーに表示されます。一部だけ隠したい場合は
**ホワイトリスト**を選び、利用を許可するユーザーを選択します。許可されていないユーザーには
接続一覧・転送候補・関連ジョブが表示されず、StorageやDataLineageのURLを直接開いても
存在を明かさないため404になります。`connections:manage`権限を持つ管理者は、空の
ホワイトリストを修正できるよう常にアクセスできます。

#### この接続で許可する操作

Glacier Deep Archive のように **一覧には出るが `GetObject` すると失敗する / 復元課金が発生する** バケットや、書き戻したくない本番バケットを登録したときのためのトグルです。**既定はすべて許可**で、危険な接続だけ後から落とします。

| 項目 | オフにすると |
| --- | --- |
| バケット / オブジェクトの一覧 | この接続では何も見られなくなる (完全に凍結したいとき用) |
| ファイルのプレビュー | テキスト / 画像 / 音声 / MP4動画のプレビューが開かない |
| ファイルのダウンロード | DL ボタンと行メニューのダウンロードが消える |
| 圧縮ファイルを開く | `tar` / `tar.gz` / `tar.xz` の中身を開けない |
| 音声情報・波形の表示 | 音声解析 (ファイル全体の読み込み) が走らない |
| スペクトログラムの表示 | スペクトログラム画像を出さない |
| README の読み込み | ディレクトリ README のセクションと README 検索が消える |
| README の編集 | 「編集 / 作成」が消える (読み込みがオフだと選べません) |

オフにした操作は画面から導線が消えるだけでなく、**共有 Web URL を直接開いても 403** で止まります。接続capabilityはRBACに重ねる防御層で、`connections:manage`権限を持つUserだけがSettingsから変更できます ([セキュリティ](#セキュリティ))。

Settings の接続一覧には、制限のかかっている接続に「制限: …」が表示されます。

タグは接続ごとではなく **Mado 全体**の表示トグルです (Settings → 機能)。オフにしても登録済みのタグは消えません。

<img width="567" height="767" alt="image" src="https://github.com/user-attachments/assets/e01ab4e2-6139-4f5c-b459-c7c40136ef48" />

### 2. バケット / ディレクトリをブラウズする (Storage)

**Storage** タブは**デフォルト接続**を自動で開きます。別の接続に切り替えるときは右上の **CONN** メニュー、デフォルトの変更は **Settings** の各接続行の「デフォルトにする」から。

- ディレクトリをクリックして潜る / パンくずで戻る
- 上部の検索ボックスで **前方一致** 検索 (再帰検索オプションあり)
- 一覧が多いときは下部のページャでめくる

<img width="1836" height="853" alt="mosaic_20260524162504" src="https://github.com/user-attachments/assets/3f5016e5-a982-4ffc-8b47-c7f14540e331" />

### 3. ファイルをプレビューする

ファイルの行をクリックすると **右側にプレビュー** が開きます (テキスト / 画像 / 音声 / MP4動画)。

- プレビューの **左端の境界をドラッグ** して幅を調整できます (リストを圧縮せず上に重なる形で広がる)。変更した幅は記憶され、ヘッダの **`↔`** で既定幅に戻せます
- ヘッダの **DL** で元ファイルをダウンロード
- テキスト / JSON は **「内容をコピー」** で全文をクリップボードへ

### 4. tar / tar.gz / tar.xz の中身を見る

アーカイブを開くと **中のエントリ一覧** が表示されます。エントリをクリックすると個別にプレビュー (テキスト / 画像 / 音声 / MP4動画) でき、テキストは **「内容をコピー」** で全文コピーできます。

<img width="720" height="302" alt="mosaic_20260524163953" src="https://github.com/user-attachments/assets/e5a41326-34b9-45a2-adaf-94b0e4ef4066" />

### 5. URL コピー / ダウンロード

各行の **`⋯` メニュー** から:

- **Web URL をコピー** — そのファイルのプレビューを直接開く共有リンク (LAN / VPN 内の相手に渡せる)
- **S3 URL をコピー** — `s3://バケット/キー`
- **このファイルをダウンロード**

### 6. ディレクトリごとの README

各ディレクトリの上部に **S3 README** が表示されます。**編集** (✎) で Markdown を書き、**履歴** (⏱) で過去の版を確認できます。長い README は折りたたまれ、「すべて表示」で展開します。

<img width="1310" height="825" alt="mosaic_20260524163749" src="https://github.com/user-attachments/assets/3cacc87c-d68c-412b-a2a6-f5a33609401b" />

### 7. チーム共有ノート (Home)

**Home** は Mado 全体で 1 つの **Team note** (Markdown)。メンバー全員で追記していく共有メモで、**編集** / **履歴** が使えます。

<img width="1298" height="829" alt="image" src="https://github.com/user-attachments/assets/3cf9c21c-bbf6-4ad6-9a68-cf0b1229633f" />

### 8. 配下の集計と移送の見積もり

一覧の上部にある **「配下を集計する」** で、そのディレクトリ配下のオブジェクト数と合計サイズを数えます (`ListObjects` だけを使うので、ファイルは 1 つもダウンロードしません)。54 万キー規模でも数分で終わりますが、重い接続では Settings のトグルで禁止できます。

集計が終わると、同じモーダルの **「移送の見積もり」** タブで「このデータを他の接続へ移すとどうなるか」を比較できます。

バケット直下ではREADMEの下にある **「バケットの容量メトリクスを見る」** から、接続内の
全バケットを縦に並べた容量履歴画面を開けます。画面上部には全バケットの容量・オブジェクト数の
合計と計測済み件数も表示します。定期計測は初期状態で無効で、周期はコネクション編集画面で
6時間〜7日から選びます。設定変更と **「今すぐ全バケットを計測」** は
`connections:manage`権限を持つUserだけが実行できます。完全なバケット全体走査だけが履歴になり、
途中終了した値はグラフへ混ぜません。

| 列 | 内容 |
| --- | --- |
| 所要 | 楽観〜悲観のレンジ。両端の帯域とオブジェクト数から出す |
| 初期 | 移動元から出す費用 (egress) + 取り出し + リクエスト料金 |
| 月額 | 移動先に置き続けたときの追加コスト |

行を開くと内訳と注意書きが出ます。**移動元から出す費用を隠していない**のが要点で、AWS から数十 TB 出すと、そのまま置き続けるより高くつくことがあります。

数字の精度について:

- **オブジェクト数を見ています。** 一般の料金計算ツールは「何 GB か」しか受け取りませんが、実際にはリクエスト料金も所要時間もオブジェクト数で決まります。平均サイズが小さいと帯域ではなくリクエストが律速になり、GB だけの見積もりは桁で外れます
- **所要時間は必ずレンジで出します。** 接続ごとの帯域は Settings で実測値に置き換えられます (既定は当て推量です)
- 目的は桁と大小関係を合わせることであって、請求書を再現することではありません。無料枠や既存の使用量との合算は考慮していません

社内ストレージ (AWS / Wasabi 以外) は費用 0 として扱います。「金は掛からないが容量は有限」という実際の判断軸に寄せるため、容量を設定しておくと収まらない移送に警告が出ます。

<a id="料金カタログ"></a>

#### 単価はどこから来るか

AWS の料金 API から取得して DB にキャッシュしています。脚注に取得日が出るので、古ければ **「単価を更新」** を押してください。しばらく更新されていなければ、見積もりを開いたついでに裏で取り直します (その回の表示は古い単価のままで、次回から反映されます)。

**外向きの通信ができない環境でも見積もりは出ます。** その場合はリポジトリに同梱されたカタログが使われ、脚注に「同梱の YYYY-MM-DD 版（まだ取得していません）」と出ます。費用 0 が「無料」なのか「単価を引けていない」のかを取り違えないよう、出所は必ず表示されます。

**ただし、更新で新しくなるのは AWS の単価だけです。** 以下は料金 API から取れないため手で持っており、更新しても変わりません。

- AWS の最小保存期間と最小課金サイズ、Glacier 系のオブジェクトごとの加算 (40KB)
- Glacier Deep Archive のストレージ単価 (同額の別クラスの値で代用)
- **Wasabi のすべて** (Wasabi は料金 API を公開していません)

これらは脚注の「一部の値は料金 API から取れないため手入力です」を開くと、何を手で持っているか・いつ一次ソースで確認したか・出典が読めます。候補の行を開けば、その移動先の単価が手入力かどうかも出ます。実際の契約単価があれば **接続の設定でストレージ単価を上書き**してください (そちらが優先されます)。

### 9. Dataset Lineage

**Lineage**でnamespaceとDataset/Job名を指定すると、MarquezのOpenLineage projectionをグラフ表示します。ノードを選ぶとRegistry正本の版、manifest/hash、保存場所、Git SHA、container、config、model、metricsを確認できます。

Pipelineへの導入方法、DatasetとVersionの分け方、OpenLineage event例、既存データのbackfill、S3接続とのbindingは
[`docs/lineage.md`](docs/lineage.md)にまとめています。Lineageを新しく生やす前にこのガイドを確認してください。

- logical表示: `Dataset → Job → Dataset`
- versions表示: 明示したDatasetVersion UUIDから`Version → Run → Version`
- 「最新らしい版」は推測しません。版表示には明示version IDが必要です
- Registryが正本で、Marquez停止中は警告を表示します。MadoからMarquezへ直接書き込みません

Adminの**Access**ではLocal UserとService Accountを作成し、`lineage:write`と許可namespaceを持つkeyを発行できます。keyの秘密部分は発行時に一度だけ表示されます。

### バージョン確認

**Settings** の一番下 **About** に、バージョン・稼働中のコミット (GitHub リンク) ・リポジトリが表示されます。

---

## セットアップ (管理者向け)

### 前提

- Docker + Docker Compose v2
- macOS / Linux (dev は macOS Docker Desktop を想定)
- LAN / VPN 内利用前提。インターネット公開は想定していない

### クイックスタート (dev)

```bash
# 1. .env を用意
cp .env.example .env

# 2. ENCRYPTION_KEY を生成して .env に書く (32 byte hex)
openssl rand -hex 32

# 3. 起動 (--build はコミット情報を About に焼くため初回 / 更新時に推奨)
docker compose -f compose.dev.yaml up -d --build

# 4. 初回Local Adminを作成（対話入力。既知の初期passwordは存在しない）
docker compose -f compose.dev.yaml exec api-internal \
  npm run auth:bootstrap-admin:dev -- --username admin

# 5. ブラウザで http://localhost:5173
```

dev の DB パスワードは未設定なら開発用の既定値で動きます。初回起動時のみ `db/init/00-init.sh` が `dashboard_rw` / `dashboard_ro` / `mado_lineage` ロールと `dashboard_test` DB を作成します。作り直したいときは `down -v` で volume を消してから上げ直してください。

### 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | yes | api コンテナの listen ポート (compose 側で 3000 に上書き) |
| `DATABASE_URL_RW` | yes | `dashboard_rw` 接続 URL。**compose 内なので host は `postgres`** |
| `DATABASE_URL_RO` | yes | `dashboard_ro` 接続 URL |
| `DATABASE_URL_RW_TEST` | no | テスト用。host から接続するので `localhost`。未設定なら default に fallback |
| `POSTGRES_PASSWORD` | prod:yes / dev:no | `postgres` スーパーユーザのパスワード。**prod は未設定だと起動失敗**、dev は既定 `postgres` |
| `DASHBOARD_PASSWORD` | prod:yes / dev:no | `dashboard_rw` / `dashboard_ro` のパスワード。**`DATABASE_URL_*` のパスワードと一致必須**。dev 既定 `CHANGEME` |
| `LINEAGE_DB_PASSWORD` | prod:yes / dev:no | Internet向け`api-lineage`専用の最小権限DB role。英数字hexの生成値を推奨 |
| `ENCRYPTION_KEY` | yes | `storage_connections` の S3 認証情報を AES-256-GCM で暗号化するキー (32 byte hex) |
| `ALLOWED_ORIGINS` | yes | CSRF 防御。write 系で許容する Origin (カンマ区切り)。dev: `http://localhost:5173` / prod: ダッシュボードを開く URL |
| `MADO_ENV` | no | `development` / `test` / `production`。本番composeは`production`を固定し、安全でない認証設定を起動時に拒否 |
| `AUTH_MODE` | no | `disabled` / `local` / `oidc` / `hybrid`。`MADO_ENV=production`では未設定・`disabled`を起動時に拒否 |
| `AUTH_COOKIE_SECURE` | no | HTTPS本番は`true`必須。`__Host-` session cookieを使う |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | oidc/hybrid | OIDC discovery issuer、client、callback URL |
| `OIDC_ALLOWED_GROUPS` | oidc/hybrid | ログインを許可するAuthentik group（カンマ区切り）。空は起動時に拒否 |
| `OIDC_ROLE_MAPPING_JSON` | no | Authentik groupから`viewer` / `curator` / `operator` / `admin`への対応。設定時はログインごとに同期 |
| `OIDC_AUTO_LINK_VERIFIED_EMAIL` | no | `email_verified=true`の既存Local Userを自動連携（default false）。特権Local Userは自動連携しない |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | no | Authentik logout後の戻り先。未指定時はcallbackと同じoriginの`/` |
| `DATASET_REGISTRY_URL` | lineage | Dataset Registry API URL |
| `DATASET_REGISTRY_TOKEN` | lineage | Mado→Registry内部Bearer token。Pipeline keyとは別物 |
| `MARQUEZ_URL` | lineage | read-onlyで参照するMarquez URL |
| `PREVIEW_TEXT_LIMIT` | no | テキストプレビュー最大バイト (default 65536) |
| `PREVIEW_TAR_ENTRY_LIMIT` | no | tar 内 1 ページのエントリ最大数 (default 200) |
| `PREVIEW_TARXZ_BYTE_LIMIT` | no | tar.xz の解凍バイト上限 (default 256MiB) |
| `MEDIA_CONCURRENCY` | no | media-worker が同時実行する ffmpeg 解析数の上限 (default 3) |
| `MEDIA_ANALYZE_TIMEOUT_SEC` | no | 音声 1 ファイルあたりの解析タイムアウト秒 (default 300) |
| `MEDIA_CACHE_MAX_AGE_DAYS` | no | 解析結果キャッシュ (`media_cache`) の保持日数 (default 30) |
| `MEDIA_SPECTROGRAM_MAX_WIDTH` | no | スペクトログラム画像の最大幅 (px) (default 4096) |

> ⚠️ `POSTGRES_PASSWORD` / `DASHBOARD_PASSWORD` / `LINEAGE_DB_PASSWORD` は **DB ボリュームの初回作成時のみ** 反映されます。既存 DB のパスワード変更は env ではなく `psql` の `ALTER ROLE` が必要です (詳細は [`db/README.md`](db/README.md))。生成例: `openssl rand -hex 24`

### 料金カタログの運用

移送の見積もりに使う単価は、AWS の料金 API から取得して `pricing_cache` テーブルに 1 行だけキャッシュします ([使い方](#料金カタログ))。

- 取得は `pricing.refresh` ジョブとして media-worker が実行します。**外向きに HTTPS が出られる必要があります** (`calculator.aws` と `pricing.us-east-1.amazonaws.com`)
- 更新の間隔は `app_settings` の `pricing_refresh_days` (既定 1 日)。これより古くなると、見積もりを開いたときに裏で更新ジョブが投入されます。表示はその回だけ古い単価のままです
- **出られない環境でも壊れません。** 取得が失敗しても同梱カタログ (`api/pricing/catalog.ts`) で見積もりは出ます。失敗しても次の投入までは間隔が空くので、ジョブが失敗で埋まることもありません
- 同梱カタログを新しくするには、外に出られるマシンで `cd api && npm run pricing:fetch` を回して結果をコミットします
- いま何を使っているかは `GET /api/internal/pricing` でも確認できます (出所・取得日・直近の失敗理由)

> ⚠ この機能は `db/migrations/020_pricing_cache.sql` を使います。**既存の DB には手で適用が必要**です ([`db/README.md`](db/README.md) の「Applying a migration to an existing database」)。

### 認証とLineageの初期化

既存DBには`021_auth.sql`以降の未適用migrationを番号順に適用します。ただし`028`は旧APIが参照する列を削除するため、既存環境では**新APIを先に起動してから`028`を適用**してください（`021`〜`027`は従来どおりコード起動前に適用できます）。`029`は未使用の既知bootstrap credentialを削除し、OpenLineage API専用DB roleを追加します。新規導入では既定passwordを持つAdminを残さないため、Webを公開する前に次のoffline bootstrapを必ず実行します。

初期Adminを明示的に再設定する場合は、対話的なbootstrapコマンドを使います（パスワードを引数やshell historyへ残しません）。

```bash
docker compose -f compose.prod.yaml exec api-internal \
  npm run auth:bootstrap-admin -- --username admin
```

passwordはTTYからのみ読み、引数・環境変数・ログには渡しません。初回bootstrap時も入力した一時passwordは初回ログインで変更必須です。平常時はOIDC Adminを使う構成でも、IdP障害用に独立したLocal Adminを1つ維持してください。

Pipelineは`MADO_API_HOSTNAME`の`POST /api/openlineage/v1/lineage`へService Account keyをBearer送信します。Madoがprofile/scope/namespaceを検証し、keyを除いたprincipal envelopeをRegistryへ転送します。production nginxはintranet UI用`:8080`とOpenLineage専用`:8081`を分離し、`:8081`ではこのPOSTだけを受け付け、その他のpath/methodを404にします。Composeは両listenerをhostのloopbackへだけpublishし、MDX edgeではbrowser用`MADO_HOSTNAME`と公開API用`MADO_API_HOSTNAME`を別TLS vhostとして終端します。

### OSSリリース

MadoはSemVerを採用し、最初の正式版候補を`v1.0.0`とします。GitHub上のannotated tagだけがrelease workflowを起動し、通常の`main` pushや社内deployからOSS releaseが始まることはありません。

公開時は同一commitからLinux amd64/arm64対応のcompiled OCI imageを3つ作り、GHCRへ配置します。

- `ghcr.io/aida0710/mado-api:<tag>`: internal APIとOpenLineage API
- `ghcr.io/aida0710/mado-media-worker:<tag>`: ffmpeg worker
- `ghcr.io/aida0710/mado-web:<tag>`: Web UIと用途別nginx入口

GitHub Releaseには、image digestを固定したCompose、DB初期化・全migration、設定例、licenseをまとめたbundleとSHA-256を添付します。OCI imageにはSBOMとbuild provenanceを付与します。release本文は[`docs/releases/`](docs/releases/README.md)、公開手順と安全条件は[`docs/releasing.md`](docs/releasing.md)を正本とします。

OSS releaseと社内環境へのdeployは独立しています。release workflowはdeployment hostへ接続しません。

### ソースからの社内デプロイ

```bash
./deploy.sh   # main を pull し、compose.prod.yaml で再ビルド + 再起動
```

`deploy.sh` は稼働中コミットを About に焼くため git 情報を build に渡します。dev との差分:

- nginx のintranet UI入口を`127.0.0.1:8080`、OpenLineage専用入口を`127.0.0.1:8081`へpublishし、どちらも用途別のhost reverse proxyを必須にする (api コンテナはホスト非公開)
- api は image build 時の `tsc` 成果物 (`dist/`) を `node` で実行
- nginx と api は **non-root user** で動作
- 全コンテナが `restart: unless-stopped`
- **prod は `POSTGRES_PASSWORD` / `DASHBOARD_PASSWORD` が `.env` に無いと起動しません** (弱い既定値の埋め込み防止)

---

## セキュリティ

このダッシュボードは認証を備えていますが、公開入口のTLSとネットワーク制御は引き続き必要です:

- **外部公開前にHTTPS必須**。標準配布bundleはloopback上のHTTP入口へ用途別TLS proxyを接続します。Browser側TLS終端後に`AUTH_COOKIE_SECURE=true`と`AUTH_MODE=local|oidc|hybrid`を設定します。
- MDXでは`compose.mdx.yaml`の`edge` nginxがbrowser用TLSを終端します。証明書取得・UFW・自動更新は[`docs/mdx-tls.md`](docs/mdx-tls.md)を参照してください。
- Web UI、`/api/auth/`、`/api/internal/`はintranet内に閉じます。外部公開するhost TLS proxyは`127.0.0.1:8081`だけへ接続し、OpenLineage ingest以外を公開しません。公開入口には送信元IP 10 req/s（burst 50）・全体50 req/s（burst 200）のrate limit、送信元20・全体200のconnection limit、2 MiB body上限、timeout、`Cache-Control: no-store`を設定済みです。
- productionは認証無効で起動できません。初期・一時passwordの変更完了前は、直接APIを呼んでも通常機能を利用できません。
- Browser sessionとPipeline Service Account keyを分離し、API keyはhashだけを保存します。
- RBACと接続capabilityを重ね、監査ログには成功して実際に状態が変わった操作だけを残します。閲覧、認証拒否、失敗した操作、同じ値の再保存、既存ジョブへの合流は記録しません。変更操作は開始時にdurableなintentを置き、失敗・変更なしなら破棄します。password/token/OIDC code/OpenLineage event本体は保存しません。
- sessionの利用時刻、login attempt、response cache、API keyの最終利用時刻など、認証・cache維持のための内部更新は操作監査の対象外です。
- **`ENCRYPTION_KEY`** で `storage_connections` の S3 認証情報を保存時暗号化 (AES-256-GCM)。DB ダンプだけ漏れても解読不能。
- **CSRF 防御**: write 系 (POST/PUT/DELETE) は `ALLOWED_ORIGINS` と Origin/Referer を照合し、不一致なら 403。
- **PG ロール分離**: ブラウザ由来の経路は `dashboard_rw` / `dashboard_ro` を使い分け、Postgres レベルで `DROP TABLE` 等を防ぐ。
- **接続ごとのcapability**はRBACとは別層です。Adminであっても接続側で無効なdownload等は実行できません。
- **接続ホワイトリスト**は通常接続を全員公開のまま保ち、例外の接続だけUser単位で隠します。非許可時は一覧・Storage API・DataLineage解決・関連job・転送候補を404相当で隠します。

Authentikとの接続、JIT User、group RBAC、Front/Back-channel logoutの登録値は
[`docs/authentik.md`](docs/authentik.md)にまとめています。

---

## 開発者向け

### アーキテクチャ

dev / prodとも、ブラウザsession用`api-internal`とPipeline key用`api-lineage`を別processにします。Dataset metadataの正本はRegistry、Marquezはoutboxから再構築できるprojectionです。

```
                 ┌─ docker compose ──────────────────────────────┐
Browser ─:5173 ─►│ front (vite dev / dev)                        │
 またはhost proxy│   または                                      │
                 │ nginx :8080 (intranet UI / prod)              │
                 │   └─► /api/internal/* → api-internal (Hono)   │
                 │   └─► /api/auth/*     → api-internal          │
Pipeline ─TLS proxy─► nginx :8081 (POST ingest only)              │
                 │   └─► /api/openlineage/v1/lineage → api-lineage│
                 │                              ├─► media-worker │
                 │                              │    (ffmpeg)    │
                 │                          postgres             │
                 └───────────────────────────────────────────────┘
                 公開ポート: dev=5173
                 host loopback: prod UI=:8080 / OpenLineage=:8081
```

| サービス | dev | prod |
|---|---|---|
| `front` | `vite dev` (HMR) | (なし、nginx に焼き込み) |
| `nginx` | (なし、Vite proxy が代替) | `:8080` 静的配信・内部API + `:8081` OpenLineage POST専用 |
| `api-internal` | `tsx watch internal.ts` | `node dist/internal.js` |
| `api-lineage` | `tsx watch lineage.ts` | `node dist/lineage.js` |
| `media-worker` | `tsx watch worker.ts` | `node dist/worker.js` |
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

---

## クレジット

- ロゴ (`front/public/mado-icon.png`): "Window" icon by [Inmotus Design](https://icons8.com/icon/set/window/external-others-inmotus-design) on [Icons8](https://icons8.com/)。Icons8 の無料利用規約により attribution を明記。

---

## License

Mado is licensed under the [Apache License 2.0](LICENSE).
