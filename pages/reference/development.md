---
description: Front、API、media worker、Registryの役割と、開発時の起動・検証・ドキュメント更新。
---

# 構成と開発

madoはReactのWeb UI、HonoのAPI、ffmpegを使うmedia worker、PostgreSQLで構成します。Dataset RegistryはLineageメタデータの正本で、Marquezは再構築できる投影です。

## ブラウザとPipelineの入口を分ける

| サービス | 役割 |
| --- | --- |
| front / nginx | 開発時のVite、または本番のWeb UI配信とproxy |
| api-internal | ブラウザの認証、Storage、設定、読み取りAPI |
| api-lineage | PipelineからのOpenLineage受け付け |
| media-worker | 音声情報、波形、スペクトログラムの解析 |
| postgres | 接続設定、認証、ノート、ジョブ、キャッシュ |
| Dataset Registry | Dataset・Version・Run・保存場所のメタデータ |
| Marquez | OpenLineageに基づくグラフの投影 |

本番のnginxはUI用の8080とOpenLineage専用の8081を持ち、hostのloopbackにだけ公開します。利用者にはTLS proxyを通したURLを案内します。

## 開発環境で起動する

```bash
docker compose -f compose.dev.yaml up -d --build
docker compose -f compose.dev.yaml logs -f api-internal front
```

`front/` と `api/` はbind mountで反映します。FrontはHMR、APIは `tsx watch` で更新します。ホストにNode.js 22を用意する場合は、依存を各ディレクトリに入れます。

```bash
npm ci --prefix front
npm ci --prefix api
```

## 変更した箇所を検証する

```bash
docker compose -f compose.dev.yaml up -d postgres
npm test --prefix api
npm run lint --prefix api
npm run build --prefix api
npm test --prefix front
npm run lint --prefix front
npm run build --prefix front
```

APIのDBテストは `DATABASE_URL_RW_TEST` の設定を使います。DBのパスワードが合わない場合は、volumeを作り直す前に接続設定と既存ロールの値を確認してください。

## GitHub Pagesの本文を更新する

このサイトのソースは `pages/` にあります。Markdownと画像を更新して `main` にpushすると、GitHub Actionsがビルドと公開を行います。

```bash
npm ci --prefix pages
npm run dev --prefix pages
npm run build --prefix pages
```

公開前の確認には `npm run preview --prefix pages` を使います。画像の撮影・更新方法は[ドキュメントの保守手順](https://github.com/aida0710/mado/blob/main/pages/README.md)に記載しています。
