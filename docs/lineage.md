# Dataset Lineageを登録する

この文書は、MadoのLineageへデータセットと処理履歴を登録する人のための運用ガイドです。
内部構成の設計理由は
[`superpowers/specs/2026-08-26-auth-lineage-platform-design.md`](superpowers/specs/2026-08-26-auth-lineage-platform-design.md)
を参照してください。

Madoでは、S3のディレクトリ同士を画面から手で線にしません。Pipelineが実行時に送る
OpenLineageイベント、または根拠を確認した既存データのbackfillから、次の関係を作ります。

```text
論理表示: Dataset ──入力──> Job ──出力──> Dataset
版表示:   DatasetVersion ──入力──> Run ──出力──> DatasetVersion
```

## 1. 最初に決めること

### Dataset、Version、Runの違い

| 要素 | 意味 | 例 |
|---|---|---|
| Dataset | 保存先とは独立した、長く使う論理名 | `mdx-speech / podcast/dialogue-classification` |
| DatasetVersion | 内容または意味が固定された不変の版 | `2026-08-24-6eaf5053` |
| StorageLocation | 同じ版を置いている場所 | `s3://dataset/podcast/.../` |
| Job | 処理方法の論理名 | `mdx-speech / classify-dialogue` |
| Run | Jobを1回実行した記録 | UUID 1個 |

次の規則を先に固定してください。

- 別のS3へ**同じバイト列をコピーしただけなら、新しいVersionを作らない**。同じVersionへStorageLocationを追加する。
- 内容、schema、抽出条件、学習用途などの意味が変わったら、新しいVersionを作る。
- 同じ入力と設定で再実行してもRunは毎回新しくする。Run IDを別実行へ使い回さない。
- Versionはimmutableとして扱う。同じVersion名の中身を後から差し替えない。
- 保存場所が消えてもDatasetやVersionを消さない。Locationの状態を`missing`または`deleted`にする。
- 「最新らしい版」や、ディレクトリ名から親子関係を推測しない。

### IDの推奨形式

`namespace`はチームまたはデータ領域、`name`は論理データセット名として安定させます。
S3のbucket名や一時的なPipeline DB名をnamespaceにしないでください。

```text
namespace: mdx-speech
dataset:   podcast/dialogue-classification
version:   2026-08-24-6eaf5053
job:       classify-dialogue
runId:     1実行ごとに生成するUUID
```

Versionにはrelease ID、manifest hash、content hashなど、後から同じ内容を一意に再指定できる値を使います。
単独の`latest`や、再実行のたび意味が変わる日付だけの値は避けます。

## 2. 新しいPipelineから自動登録する

通常はこちらを使います。PipelineはMadoだけへOpenLineageイベントを送り、RegistryやMarquezへ
直接接続しません。

```text
Pipeline
  └─ POST /api/openlineage/v1/lineage
       └─ Mado: API key、scope、namespaceを検証
            └─ Dataset Registry: 正本をtransaction保存
                 └─ outbox worker
                      └─ Marquez: 再構築可能な論理グラフ
```

### 2.1 Service Accountを発行する

管理者がMadoの次の画面で発行します。

```text
Settings → Access → Service Accounts
```

1. Pipeline単位のService Accountを作る。
2. `lineage:write` scopeを持つLineage API keyを発行する。
3. Pipelineが書くnamespaceをallow listへ入れる。
4. 画面に一度だけ表示されるkeyをsecret managerへ保存する。

Job namespaceと、全output Datasetのnamespaceに書き込み権限が必要です。Inputが別namespaceにあり、
まだRegistryへ登録されていない場合は、そのinput namespaceも必要です。最初から`*`を渡すのではなく、
Pipelineごとに必要なnamespaceだけを許可してください。

API keyをGit、Dockerfile、ログ、README、OpenLineage event本体へ入れないでください。

### 2.2 送信先

```http
POST https://mado.example/api/openlineage/v1/lineage
Authorization: Bearer mado_lin_...
Content-Type: application/json
```

本番ではkeyを環境変数またはsecret fileから読みます。以下では名前を
`MADO_LINEAGE_KEY`、Madoのoriginを`MADO_URL`とします。

作成したevent fileは次のように送れます。`--data-binary`を使い、再送時にも同じJSONを送ってください。

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${MADO_LINEAGE_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary @openlineage-event.json \
  "${MADO_URL}/api/openlineage/v1/lineage"
```

### 2.3 最小イベント

Mado profileでは、すべての内部Dataset input/outputにVersion identityが必須です。
標準OpenLineageの`version.datasetVersion`を使うのが最も簡単です。

```json
{
  "eventTime": "2026-08-27T00:00:00Z",
  "eventType": "START",
  "run": {
    "runId": "3e5ea6d2-4952-49ee-a6fb-7c8ba1b087f8",
    "facets": {}
  },
  "job": {
    "namespace": "mdx-speech",
    "name": "classify-dialogue",
    "facets": {}
  },
  "inputs": [
    {
      "namespace": "mdx-speech",
      "name": "podcast/raw",
      "facets": {
        "version": {
          "datasetVersion": "2026-08-20-raw-a13f"
        }
      }
    }
  ],
  "outputs": [],
  "producer": "https://github.com/example/podcast-pipeline",
  "schemaURL": "https://openlineage.io/spec/2-0-2/OpenLineage.json"
}
```

処理が成功したら、**同じ`runId`**で`COMPLETE`を送ります。この時点で確定したoutputを含めます。

```json
{
  "eventTime": "2026-08-27T00:42:10Z",
  "eventType": "COMPLETE",
  "run": {
    "runId": "3e5ea6d2-4952-49ee-a6fb-7c8ba1b087f8",
    "facets": {
      "datasetRegistry": {
        "gitSha": "55f4fc39",
        "containerDigest": "sha256:0123456789abcdef",
        "configUri": "s3://dataset-config/classify/2026-08-27.yaml",
        "configHash": "sha256:89abcdef",
        "modelRefs": [
          {
            "name": "dialogue-classifier",
            "revision": "2026-08-15",
            "hash": "sha256:13579bdf"
          }
        ],
        "runtime": {
          "image": "example/classifier@sha256:0123456789abcdef",
          "python": "3.12"
        },
        "metrics": {
          "inputEpisodes": 24240565,
          "outputEpisodes": 77700
        }
      }
    }
  },
  "job": {
    "namespace": "mdx-speech",
    "name": "classify-dialogue",
    "facets": {}
  },
  "inputs": [
    {
      "namespace": "mdx-speech",
      "name": "podcast/raw",
      "facets": {
        "version": {
          "datasetVersion": "2026-08-20-raw-a13f"
        }
      }
    }
  ],
  "outputs": [
    {
      "namespace": "mdx-speech",
      "name": "podcast/dialogue-classification",
      "facets": {
        "version": {
          "datasetVersion": "2026-08-24-6eaf5053"
        },
        "datasetRegistry": {
          "contentHash": "sha256:2468ace0",
          "manifestUri": "s3://dataset/podcast/dialogue-classification/manifest.jsonl",
          "manifestHash": "sha256:abcdef01",
          "storageLocations": [
            {
              "systemKey": "mdx-s3",
              "kind": "s3",
              "uri": "s3://dataset/podcast/dialogue-classification/",
              "bucket": "dataset",
              "region": "us-east-1",
              "isPrimary": true
            }
          ]
        }
      }
    }
  ],
  "producer": "https://github.com/example/podcast-pipeline",
  "schemaURL": "https://openlineage.io/spec/2-0-2/OpenLineage.json"
}
```

失敗時は同じ`runId`で`FAIL`、利用者による中断なら`ABORT`を送ります。失敗理由は
`run.facets.datasetRegistry.errorMessage`へ、秘密値や巨大なstack traceを除いて入れます。

### 2.4 Madoが読む追加field

OpenLineage標準fieldに加え、Madoは次の`datasetRegistry` custom facetを読みます。

Dataset facet:

| field | 用途 |
|---|---|
| `contentHash` | DatasetVersion本体のhash |
| `manifestUri` | object一覧・size・hashを持つimmutable manifest |
| `manifestHash` | manifest自体のhash |
| `storageLocations[]` | 同じVersionの保存先 |
| `storageLocations[].systemKey` | Registry内のStorageSystem識別子 |
| `storageLocations[].uri` | `s3://...`等の保存場所 |

Run facet:

| field | 用途 |
|---|---|
| `gitSha` | 実行コードのcommit |
| `containerDigest` | tagではなくimage digest |
| `configUri` / `configHash` | 実行設定とそのhash |
| `modelRefs[]` | model名、revision、hash等 |
| `runtime` | image、言語、GPU、ライブラリ等 |
| `metrics` | 入出力件数、除外件数、品質指標等 |
| `errorMessage` | FAIL/ABORTの要約 |

Custom facetのfieldは増やせますが、Mado詳細画面に構造化表示されるのは上記です。API key、
password、presigned URLなどのsecretはfacetへ入れないでください。

### 2.5 Pipeline実装の骨格

次の順序をPipelineの共通wrapperへ入れます。

```python
run_id = uuid.uuid4()
send_openlineage(event_type="START", run_id=run_id, inputs=inputs, outputs=[])

try:
    result = run_pipeline()
except KeyboardInterrupt:
    send_openlineage(event_type="ABORT", run_id=run_id, inputs=inputs, outputs=[])
    raise
except Exception as exc:
    send_openlineage(
        event_type="FAIL",
        run_id=run_id,
        inputs=inputs,
        outputs=[],
        error_message=redact_and_summarize(exc),
    )
    raise
else:
    send_openlineage(
        event_type="COMPLETE",
        run_id=run_id,
        inputs=inputs,
        outputs=result.outputs,
        metrics=result.metrics,
    )
```

送信に失敗しても処理本体の結果を失わないよう、eventをローカルqueueへ残して再送できる構成を推奨します。
同じJSON eventの再送はRegistry側でdeduplicateされます。

## 3. 保存場所からMado Storageへ移動できるようにする

OpenLineageの`storageLocations[].systemKey`と、MadoのS3 Connection IDは別の識別子です。
管理者が一度だけ`lineage_storage_bindings`で対応付けます。

```text
Registry StorageSystem `mdx-s3`
        ↕ binding
Mado Connection `mW5dNSSMcQ`
```

これにより次の往復が可能になります。

- Storageのprefix → 登録されたDataset → Lineage
- LineageのVersion → StorageLocation → Mado Storage

現在はbinding用UIがないため、Compose管理者がDBへ登録します。まず対象を確認します。

```bash
docker compose -f compose.mdx.yaml exec postgres \
  psql -U postgres -d dashboard -c \
  'SELECT id, name, endpoint FROM storage_connections ORDER BY name'

docker compose -f compose.mdx.yaml exec registry-db \
  psql -U registry -d registry -c \
  'SELECT system_key, kind, endpoint FROM storage_systems ORDER BY system_key'
```

確認した値だけを明示して登録します。

```sql
INSERT INTO lineage_storage_bindings
  (connection_id, registry_storage_system_key, created_by)
VALUES
  ('MADO_CONNECTION_ID', 'REGISTRY_SYSTEM_KEY', 'operator-name')
ON CONFLICT (connection_id) DO UPDATE SET
  registry_storage_system_key = EXCLUDED.registry_storage_system_key,
  created_by = EXCLUDED.created_by;
```

`systemKey`をPipelineごとに変えないでください。同じendpointを表す安定した値を運用で決めます。
credentialはMadoのConnectionだけが保持し、Registryへは保存しません。

## 4. 既存データをbackfillする

過去データは実行時のOpenLineage eventがないため、Madoの`Lineage → 手動で登録`から
根拠を確認できた範囲を登録します。画面を利用できるのは`lineage:curate`権限を持つ
CuratorまたはAdminです。Madoは認証と監査を行い、Compose bridge内のRegistry APIへ
1回のtransactionとして保存します。Registry APIは外部公開しません。

### 画面の3つの使い分け

| 画面 | 使う場面 | 作られる記録 |
|---|---|---|
| Dataset | 初めて台帳へ載せる、または既存Datasetへ新しい版を足す | Dataset、Version、任意の保存場所・Source・処理履歴 |
| 保存場所 | 同じ内容を別のS3等へコピーした | 既存VersionにStorageLocationだけを追加 |
| 処理履歴 | 入力版と出力版は登録済みで、過去の処理関係だけを足す | Transformationと完了済みRun |

Dataset登録では、Sourceと処理履歴を同時に登録できます。購入データなら購入先をSourceにし、
クローリングならWeb site、feed、外部DB等をSourceにします。保存場所を入力する場合は、先に
`Settings → Connections`で接続を作り、Registry storage systemとのbindingを済ませてください。

手動登録した処理は`historical-lineage-assertion`として保存されます。正確な実行時刻が不明なら
「不明」のまま保存され、現在時刻を過去の実行時刻として捏造しません。同じVersionを1つのRunの
入力と出力へ同時に指定することもできません。

登録成功・失敗はAuditへ`lineage.dataset.register`、`lineage.location.register`、
`lineage.run.register`として残ります。登録済みの不変なVersionやRunを画面から上書き・削除する
機能はありません。訂正が必要なら、証拠を確認して新しいVersionまたは新しいRunとして登録します。

大量の既存データを反復可能に投入する場合だけ、Registry用のidempotent seed scriptを使います。

### 登録順序

1. 購入元、Web site、feed、外部DBをSourceにする。
2. 保存場所と独立した論理Datasetを作る。
3. 内容が確認できる単位をDatasetVersionにする。
4. manifest/hashと、実在を確認したStorageLocationをVersionへ付ける。
5. 処理方法をTransformationにする。
6. 根拠があるinput/outputだけをRunへ付ける。
7. Runを`COMPLETE`、`FAIL`または`ABORT`で終了する。

画面またはseed scriptでは`source_key`、`dataset_key`、`namespace/name`、Version名、`transformation_key`、
`run_key`を固定し、再実行しても重複しないようにします。先に一覧を取得し、存在すれば更新またはskipします。

過去の正確な実行時刻、Git SHA、model revisionが分からない場合は捏造しません。例えばmetadataへ次のように残します。

```json
{
  "recordKind": "historical-lineage-assertion",
  "executionTimeStatus": "unknown",
  "historyStatus": "documented",
  "evidence": [
    {
      "type": "s3-readme",
      "uri": "s3://dataset/example/README.md",
      "etag": "..."
    }
  ]
}
```

名前が似ている、同じbucketにある、更新日時が近い、という理由だけでedgeを追加しないでください。
不明な履歴は不明なまま登録し、後で証拠が見つかった時に補います。

### 人が探せる情報も付ける

OpenLineageから自動作成されたDatasetには、最初は機械的な`namespace/name`しかありません。backfillまたは
catalog整備時に、最低限次を追加してください。

- `display_name`: 画面で読む名称
- `aliases`: 旧名、略称、S3 URI、購入元の呼称
- `description`: 何を含み、何に使うデータか
- `media_type`: `application/x-tar`、`audio/wav`等
- `owner`: 管理チーム

これらはLineageの「登録一覧・検索」で利用されます。

## 5. 登録を確認する

### Mado画面

1. `Lineage`を開く。
2. 「登録一覧・検索」で表示名、説明、S3 URIのいずれかを検索する。
3. Datasetを選び、論理表示が`Dataset → Job → Dataset`になっていることを確認する。
4. Dataset nodeを選び、Versionを開く。
5. 版表示で`DatasetVersion → Run → DatasetVersion`を確認する。
6. 詳細のmanifest、hash、config、model、metrics、保存場所を確認する。
7. 「この保存場所をStorageで開く」が正しいprefixへ移動することを確認する。

### Compose運用確認

```bash
docker compose -f compose.mdx.yaml ps

docker compose -f compose.mdx.yaml exec registry-db \
  psql -U registry -d registry -c \
  'SELECT count(*) AS pending FROM outbox_events WHERE published_at IS NULL'

docker compose -f compose.mdx.yaml logs --tail=200 \
  registry-api lineage-worker marquez-api api-lineage
```

`pending`が一時的に増えるのは正常ですが、減らない場合は`lineage-worker`とMarquezを確認します。
Registryへの保存が成功していれば、Marquez停止中でも正本は失われません。

### HTTP statusの意味

| status | 主な原因 |
|---|---|
| `401` | keyなし、無効、失効済み |
| `403` | `lineage:write`なし、またはnamespaceがallow list外 |
| `409` | 同じIDが別の内容を指す等、Registry正本と競合 |
| `413` | eventが2 MiBを超えている |
| `422` | OpenLineage形式不正、DatasetVersion identityなし |
| `503` | 認証DBまたはRegistryが利用不能 |

## 6. よくある誤り

- Marquezへ直接送る。Madoの認証とRegistry正本を迂回するため禁止。
- `START`と`COMPLETE`で別のRun IDを使う。1回の実行が2件に分裂する。
- VersionなしのDatasetを送る。「現在の最新版」へ暗黙に接続できないため422になる。
- 同じVersion名の内容を差し替える。過去Runの再現性が壊れる。
- S3コピーのたびにDatasetVersionを作る。Replicaと派生データを混同する。
- S3 path自体をDataset identityにする。移設すると論理Datasetまで別物になる。
- tagだけをcontainer識別子にする。後から内容が変わるためdigestを保存する。
- configやmanifestのURIだけを保存し、hashを保存しない。後から差し替えを検出できない。
- 失敗時にeventを送らない。成功Runしか見えず、処理実態を誤解する。
- 過去履歴の時刻や親子関係を推測で埋める。

## 7. Pipeline導入チェックリスト

- [ ] Datasetの`namespace/name`とVersion命名規則を決めた
- [ ] Jobの`namespace/name`を決めた
- [ ] Service Accountとnamespace制限付きkeyを発行した
- [ ] 1実行につきRun UUIDを1個生成する
- [ ] `START`と`COMPLETE/FAIL/ABORT`を同じRun UUIDで送る
- [ ] 全input/outputへVersion identityを付ける
- [ ] outputへmanifest URI/hashとcontent hashを付ける
- [ ] StorageLocationへ安定した`systemKey`を付ける
- [ ] Registry StorageSystemとMado Connectionをbindingした
- [ ] Git SHA、container digest、config URI/hash、model revisionを記録する
- [ ] secretや巨大なログをfacetへ入れていない
- [ ] event再送queueがある
- [ ] Madoの論理表示、版表示、Storageリンクを確認した
- [ ] outboxのpendingが0へ戻ることを確認した
