---
description: Service Account keyのscopeとnamespace、OpenLineageイベントの送信、Prometheus容量メトリクス。
---

# Service AccountからAPIを使う

PipelineからのOpenLineage送信と、Prometheusからのメトリクス取得はService Account keyを使います。人のログイン情報をスクリプトへ渡す必要はありません。

<Screenshot src="/screenshots/service-accounts.png" alt="audio-pipelineのService Accountを管理する画面" caption="Settings → Access → Service Accountsからアカウントとkeyを管理します。" />

## 用途ごとにkeyを発行する

AdminがService Accountを作成し、必要なscopeとnamespaceを指定してkeyを発行します。keyの値は発行時に一度だけ表示されます。送信側のシークレット管理へ保存してください。

| Scope | 用途 | 入口 |
| --- | --- | --- |
| `lineage:write` | OpenLineageイベントの送信 | `POST /api/openlineage/v1/lineage` |
| `metrics:read` | 全接続の容量メトリクスの取得 | `GET /api/mado/metrics/capacity` |

mado自身のデータを返す `/api/mado/` はGETだけです。OpenLineage送信とメトリクス取得には、別々のscopeのkeyを使います。`metrics:read` はホワイトリストで利用者を限定した接続も含め、全接続のバケット名・容量を読み取れます。

## OpenLineageイベントを送信する

送信先のURLとkeyを、Pipelineの環境変数やシークレット管理から渡します。次はイベントJSONを `event.json` に用意した場合の例です。

```bash
curl --fail-with-body \
  -X POST "$MADO_LINEAGE_URL/api/openlineage/v1/lineage" \
  -H "Authorization: Bearer $MADO_LINEAGE_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @event.json
```

`MADO_LINEAGE_URL` は公開API用hostnameのorigin、`MADO_LINEAGE_KEY` は `lineage:write` のkeyです。許可されたnamespaceのイベントを送信します。イベント形式と登録の扱いは[Lineageの仕様](https://github.com/aida0710/mado/blob/main/docs/lineage.md)に記載しています。

## Prometheusで容量メトリクスを取得する

メトリクスはUI側のintranet用入口にあります。公開API用入口には載せていません。

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $MADO_METRICS_KEY" \
  "$MADO_URL/api/mado/metrics/capacity"
```

Prometheusの設定例です。Bearer tokenはファイルから読みます。

```yaml
scrape_configs:
  - job_name: mado-capacity
    scheme: https
    metrics_path: /api/mado/metrics/capacity
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/mado-metrics-key
    static_configs:
      - targets: ['mado.example.com']
```

`mado.example.com` を実際のUI用hostnameへ置き換えます。返すメトリクスの一覧は[容量メトリクスの仕様](https://github.com/aida0710/mado/blob/main/deploy/mdx/README.md#prometheus-metrics)を参照してください。

## 使わなくなったkeyは失効する

Service Accountsから対象のkeyを失効します。scopeやnamespaceを変えるときは、新しいkeyを発行して送信側を切り替えます。
