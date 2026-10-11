---
description: Docker Composeでmadoを起動する。OS別の準備、暗号化キー、初期Admin、本番構成。
---

# Docker Composeでmadoを起動する

まずソースから開発環境を起動して、ブラウザで操作を確認できます。必要なものはGit、Docker、Docker Compose v2です。

## DockerとGitを用意する

### macOS

Homebrewがある場合は、ターミナルで実行します。

```bash
brew install git
brew install --cask docker
open -a Docker
```

Docker Desktopの初回画面でセットアップを済ませ、起動完了を待ちます。Homebrewがなければ[Homebrewの導入手順](https://brew.sh/ja/)から準備してください。Docker Desktopの要件は[公式のmacOS向け手順](https://docs.docker.com/desktop/setup/install/mac-install/)で確認できます。

### Ubuntuで手元の開発環境を作る

Gitとcurlを入れ、Docker公式の開発用インストールスクリプトを使います。

```bash
sudo apt-get update
sudo apt-get install -y git curl
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

以降のDockerコマンドに権限がなければ `sudo` を付けて実行してください。本番マシンのDocker導入には、[公式のaptリポジトリによる手順](https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository)を使います。

### インストールを確認する

```bash
git --version
docker version
docker compose version
```

`docker version` でServerも表示されることを確認します。

## ソースと設定ファイルを用意する

```bash
git clone https://github.com/aida0710/mado-s3-datacatalog.git
cd mado-s3-datacatalog
cp .env.example .env
openssl rand -hex 32
```

最後のコマンドで生成した値を、`.env` の `ENCRYPTION_KEY` に設定します。このキーは保存したS3の認証情報の暗号化に使うため、運用開始後も保管してください。

`.env.example` の `AUTH_MODE=local` は、Local Userで試す設定です。DataLineageを使う場合は、互換Dataset RegistryとそのBearer token、必要に応じてMarquezを別途用意します。Registryの仕様は[API契約](https://github.com/aida0710/mado-s3-datacatalog/blob/main/docs/registry-api-contract.md)を参照してください。

## 開発環境を起動する

```bash
docker compose -f compose.dev.yaml up -d --build postgres api-internal media-worker front
docker compose -f compose.dev.yaml ps
```

まずStorageを使うサービスを起動します。PostgreSQLがhealthyになったら、初期Adminを作成します。OpenLineageの受け付けは、Registryへの接続設定を済ませてから `docker compose -f compose.dev.yaml up -d --build api-lineage` で起動できます。

## 初期Adminを作成する

```bash
docker compose -f compose.dev.yaml exec api-internal \
  npm run auth:bootstrap-admin:dev -- --username admin
```

`New admin password:` に初回用パスワードを入力し、`Confirm password:` に同じ値を入れます。初回用は8バイト以上です。初回ログイン後は12バイト以上のパスワードに変更します。英数字は1文字1バイト、日本語の多くの文字は1文字3バイトで数えます。入力した値は画面に表示されません。

ブラウザで `http://localhost:5173` を開き、ユーザー名 `admin` と設定したパスワードでログインします。初回にパスワード変更を求められたら完了し、[接続を登録](./connections.md)してください。

<Screenshot src="/screenshots/connections.png" alt="初期設定後に接続を登録するSettingsのConnections画面" caption="ログイン後、SettingsからS3互換ストレージを追加します。" />

## 本番は専用の設定とTLS proxyを使う

ソースから本番構成を起動する場合は `compose.prod.yaml` を使います。`.env` の主要な設定は次のとおりです。

| 設定 | 内容 |
| --- | --- |
| `POSTGRES_PASSWORD` | PostgreSQL管理用のパスワード |
| `DASHBOARD_PASSWORD` | `DATABASE_URL_RW` / `DATABASE_URL_RO` と一致するパスワード |
| `LINEAGE_DB_PASSWORD` | OpenLineage用DBロールのパスワード |
| `WORKER_DB_PASSWORD` | 音声解析worker専用DBロールのパスワード |
| `ENCRYPTION_KEY` | 32バイトのhex形式の暗号化キー |
| `AUTH_MODE` | `local`、`oidc`、`hybrid` のいずれか |
| `AUTH_COOKIE_SECURE` | HTTPSで使う場合は `true` |
| `ALLOWED_ORIGINS` | ブラウザが使うURLのorigin |
| `DATASET_REGISTRY_URL` / `DATASET_REGISTRY_TOKEN` | 互換Registryへの接続設定。本番では必須 |

新規環境では、Webの入口を起動する前にAdminを作成します。

```bash
docker compose -f compose.prod.yaml build
docker compose -f compose.prod.yaml up -d postgres
docker compose -f compose.prod.yaml run --rm api-internal \
  node dist/scripts/bootstrap-admin.js --username admin
docker compose -f compose.prod.yaml up -d --build
```

UIは `127.0.0.1:8080`、OpenLineage送信専用の入口は `127.0.0.1:8081` です。UIにはintranet内のTLS proxyを接続します。Pipelineの送信先を公開する場合は、別のTLS hostnameから8081へ接続します。

既存DBの更新にはmigrationの適用順があります。[DBの更新手順](https://github.com/aida0710/mado-s3-datacatalog/blob/main/db/README.md)に従ってください。リリースbundleを使う場合は[bundleの導入手順](https://github.com/aida0710/mado-s3-datacatalog/blob/main/deploy/release/README.md)を参照します。
