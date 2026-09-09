# バケット容量履歴と推移グラフ

## 背景

Mado は Storage 画面から S3 / S3 互換ストレージを横断して閲覧でき、既存の
`storage.scan` ジョブで任意 prefix 配下のオブジェクト数と合計サイズを取得できる。
一方、走査結果は `(connection_id, bucket, prefix)` ごとの最新値だけが実用上残るため、
「どのバケットが、いつ、どれくらい増減したか」は分からない。

バケット容量の時系列は、次の判断に使う。

- データ生成が想定した速度で進んでいるか
- 一括削除、移動、生成停止などの異常が起きていないか
- on-premises ストレージの容量上限にいつ到達するか
- 転送見積もりに使っている走査結果がどの程度新しいか

AWS S3 の汎用 API と S3 互換 API には、バケット総容量を一度に返す共通 API がない。
したがって、provider 固有のメトリクスを使わない限り、全 object を `ListObjects` で
列挙して `Size` を合計する必要がある。現在の `dataset` バケットでは約 547,000 key、
約 223 秒という実測があり、短周期で無条件に走査してよい処理ではない。

## 決定

**収集、履歴保存、通常の可視化は Mado に実装する。Grafana を必須構成にはしない。**

Grafana は収集器ではなく可視化器なので、採用しても容量を取得する仕組みは別途必要になる。
また Mado にはすでに Storage connection、暗号化された認証情報、SSO、connection ごとの
user whitelist、走査 job、worker がある。Grafana に直接表示すると、Mado の connection ACL
と Grafana の閲覧権限を二重管理する必要がある。

将来、Storage 容量を API error 率、worker 所要時間、DB 使用量等と横断して運用監視する段階で、
Mado が保存した最新値を Prometheus 形式で公開し、Grafana から参照できるようにする。
履歴の正本は Mado の PostgreSQL とし、Grafana を追加しても収集経路は二重化しない。

## 目的

- 明示的に追跡を有効にしたバケットを一定間隔で走査する
- 容量と object 数の履歴を immutable な snapshot として保存する
- バケット画面で現在値、前回差分、推移、最終取得日時を確認できる
- 手動走査と定期走査を同じ job / 集計実装へ合流させる
- 既存の connection ACL、capability、RBAC を迂回しない
- 巨大バケット、障害中の endpoint、worker backlog に対して安全に縮退する

## スコープ外

- object 本文の取得、tar 展開、音声時間や schema の解析
- prefix / Dataset 単位の履歴。第 1 弾は bucket root のみ
- リアルタイム容量。最短でも 6 時間間隔とする
- 使用量の予測、異常検知、通知
- provider 固有の CloudWatch、S3 Inventory、MinIO 管理 API
- Grafana、Prometheus、Alertmanager の同梱
- 過去時点の容量の復元。導入後に取得した snapshot だけを表示する

## 用語

- **追跡対象**: 定期走査を明示的に有効化した `(connection_id, bucket)`
- **snapshot**: 完全な bucket root 走査が完了した時点の `total_bytes` と `object_count`
- **手動走査**: User が「配下を集計」または「今すぐ更新」を押して開始した走査
- **定期走査**: worker の scheduler が開始した走査

## 収集方式

既存の `2026-08-18-directory-scan-design.md` は自動再走査をスコープ外としている。
本仕様はその方針を全面的に撤回するものではなく、管理者が明示的に登録した bucket root だけを
定期走査できるようにする限定的な拡張である。任意 prefix の TTL 切れや画面閲覧を契機に
自動走査することは引き続き禁止する。

### 既存走査の再利用

job kind は既存の **`storage.scan`** を維持し、payload も
`{ connId, bucket, prefix }` のままとする。定期走査は `prefix: ''` で投入する。

走査 handler は、次の条件をすべて満たした場合だけ snapshot を保存する。

1. `prefix === ''`
2. `partial === false`
3. job が cancel されていない
4. `totalBytes` と `objectCount` が非負の安全な整数

これにより、bucket root の手動走査もグラフの最新点になる。定期走査と手動走査が同時に
始まっても、既存の `jobs_active` 部分 unique index と同じ dedup key によって 1 job に合流する。
prefix 配下の走査結果は bucket 全体を表さないため履歴へ保存しない。

snapshot 保存が失敗した場合は job を成功扱いにしない。DB への job 完了書き込みもできない
状態である可能性が高く、「走査結果は見えるが履歴には無い」という不整合を作らないためである。

scan handler には容量履歴 store を注入する。bucket root 走査の開始時、完了時、partial、error を
store へ通知し、対応する target が存在する場合だけ schedule 状態を更新する。target が無効または
存在しない手動走査でも、完全な root 走査なら snapshot 自体は保存する。これにより、追跡を後から
有効化しても直近の手動測定値を初期点として表示できる。

### provider 固有方式

第 1 弾は全 connection で `ListObjects` を使う。将来は collector interface を追加する。

```typescript
interface BucketCapacityCollector {
  collect(input: {
    connectionId: string
    bucket: string
    signal: AbortSignal
    onProgress: (objects: number) => void
  }): Promise<{ totalBytes: number; objectCount: number }>
}
```

候補は以下だが、値の意味や更新頻度が provider ごとに異なるため、自動選択せず connection 設定で
明示する。

- AWS CloudWatch `BucketSizeBytes`
- S3 Inventory
- MinIO 等の管理 API
- 汎用 `ListObjects` fallback

collector が増えても snapshot schema と表示 API は変えない。

## スケジュール

### 既定値と制約

- 追跡は既定で **無効**。migration / deploy だけで既存 bucket の走査は始めない
- 有効化時の既定間隔は **24 時間**
- 設定可能範囲は **6 時間以上、7 日以下**
- UI の選択肢は 6 時間、12 時間、24 時間、3 日、7 日
- 有効化すると `next_run_at = now()` とし、最初の snapshot を早期に取得する
- 手動更新は間隔を変更しない

1 時間未満を許さないのは、容量値に必要な全 key 列挙の request 費用と endpoint 負荷を
抑えるためである。より短い周期が必要な環境では、provider 固有 collector を先に追加する。

### scheduler

既存 `media-worker` に 60 秒周期の scheduler loop を追加する。外部 cron と新しい container は
追加しない。

1. `enabled = true AND next_run_at <= now()` の追跡対象を古い順に最大 20 件読む
2. connection の `scan_enabled` を確認する。false なら投入せず `paused` とする
3. `storage.scan` を bucket root の dedup key で `enqueueWithResult` する
4. target に `last_job_id`、`last_attempt_at` を保存する
5. 同じ job がすでに実行中ならその id を採用する

定期 job は既存の単一 worker queue へ入るので、S3 request が bucket 数だけ並列に発生しない。
将来 worker を水平 scale する場合は、容量走査専用の concurrency limit を追加するまで
`storage.scan` を処理する worker は 1 replica に保つ。

### 次回実行と失敗時 backoff

- 成功: `next_run_at = completed_at + interval`
- partial: snapshot を保存せず、`next_run_at = now() + 1 hour`
- error: `consecutive_failures` を増やし、`15 min × 2^(n-1)`、最大 6 時間で再試行
- 3 回以上連続失敗しても自動で無効化しない。画面に状態を表示し、最大 6 時間 backoff を続ける
- 成功時に `consecutive_failures = 0` と `last_error = NULL` へ戻す

endpoint の一時障害で 24 時間待つことを避けつつ、恒久的な認証失敗で連打しない。
error message は secret、access key、署名済み URL、object key を保存せず、正規化した分類と
短い説明だけを保持する。

## データモデル

次の migration 番号は実装時点の最新番号に合わせる。

```sql
CREATE TABLE storage_capacity_targets (
  connection_id       TEXT        NOT NULL
      REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket              TEXT        NOT NULL,
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
  interval_seconds    INTEGER     NOT NULL DEFAULT 86400
      CHECK (interval_seconds BETWEEN 21600 AND 604800),
  next_run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_job_id         INTEGER     REFERENCES jobs(id) ON DELETE SET NULL,
  last_attempt_at     TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_status         TEXT        NOT NULL DEFAULT 'waiting'
      CHECK (last_status IN ('waiting','queued','success','partial','error','paused')),
  last_error          TEXT,
  consecutive_failures INTEGER    NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, bucket)
);

CREATE INDEX storage_capacity_targets_due
  ON storage_capacity_targets(next_run_at)
  WHERE enabled = TRUE;

CREATE TABLE storage_capacity_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  connection_id  TEXT        NOT NULL
      REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket         TEXT        NOT NULL,
  total_bytes    BIGINT      NOT NULL CHECK (total_bytes >= 0),
  object_count   BIGINT      NOT NULL CHECK (object_count >= 0),
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_id         INTEGER     REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX storage_capacity_snapshots_job
  ON storage_capacity_snapshots(job_id) WHERE job_id IS NOT NULL;

CREATE INDEX storage_capacity_snapshots_history
  ON storage_capacity_snapshots(connection_id, bucket, collected_at DESC);
```

PostgreSQL driver は `BIGINT` を文字列で返すため、API 境界で `Number.isSafeInteger` を検証して
number へ変換する。安全整数を超えた場合に丸めて表示せず、API を 422 として provider 固有の
collector / 表現形式を再検討する。現在確認済みの約 903 TB は安全整数範囲内である。

### snapshot の性質

- snapshot は更新しない。再取得は新しい行を追加する
- `job_id` の unique index により、worker 再開や完了処理の再実行で同じ点を二重保存しない
- job の保持期限後は `job_id = NULL` になるが、容量履歴は残る
- connection 削除時は credential と同じ単位で target / snapshot も cascade 削除する
- bucket が Storage 側から消えても履歴は残し、追跡状態を error とする

### 保持期間

snapshot は **400 日**保持する。worker 起動時と 1 日 1 回、次を削除する。

```sql
DELETE FROM storage_capacity_snapshots
 WHERE collected_at < now() - interval '400 days';
```

24 時間周期なら bucket あたり約 400 行、最短の 6 時間周期でも約 1,600 行であり、
専用時系列 DB や downsampling は不要である。保持期間は第 1 弾では固定し、設定項目を増やさない。

## API

### 履歴取得

```http
GET /api/internal/storage/:connId/capacity?bucket=dataset&days=90
```

- `days`: `7 | 30 | 90 | 400`、既定 90
- 時系列は `collectedAt` 昇順
- 最大 1,600 点。範囲内にそれ以上ある場合は bucket 単位で 1 日 1 点へ server-side 集約する
- snapshot がなくても 200 で target 状態を返す

```json
{
  "tracking": {
    "enabled": true,
    "intervalSeconds": 86400,
    "nextRunAt": "2026-09-10T00:00:00Z",
    "lastAttemptAt": "2026-09-09T00:00:00Z",
    "lastSuccessAt": "2026-09-09T00:04:03Z",
    "lastStatus": "success",
    "lastError": null,
    "consecutiveFailures": 0
  },
  "capacityBytes": 1099511627776000,
  "points": [
    {
      "collectedAt": "2026-09-08T00:04:01Z",
      "totalBytes": 992137445572608,
      "objectCount": 547259
    }
  ]
}
```

`capacityBytes` は connection の既存 `capacity.total_bytes` 設定で、未設定なら `null`。

### 追跡設定

```http
PUT /api/internal/storage/:connId/capacity/tracking?bucket=dataset
Content-Type: application/json

{"enabled": true, "intervalSeconds": 86400}
```

- body は strict schema
- 同値更新は DB を変更せず、監査 intent も破棄する
- 無効化しても既存 snapshot は削除しない
- 再有効化時は `next_run_at = now()`
- `scan_enabled = false` の connection では有効化を 409 で拒否する

### 手動更新

新しい endpoint は作らず、既存を使う。

```http
POST /api/internal/storage/:connId/scan?bucket=dataset&prefix=
```

完了後、同じ job handler が snapshot を保存する。既存の `GET /jobs/:id` による進捗表示と
cancel もそのまま使う。

## 認証と認可

### 閲覧

容量は object 名ほど詳細ではないが、bucket の存在、規模、増減を明らかにする情報である。
履歴 API は次をすべて要求する。

- login 済み
- `storage:read`
- 対象 connection が public、allowlist 登録済み、または `connections:manage` 保持者
- 対象 connection の `list` capability が有効

非許可 connection は既存 API と同じく **404** を返し、存在を開示しない。

### 操作

- 定期追跡の有効化、無効化、間隔変更: `connections:manage`
- 手動更新、cancel: 既存どおり `jobs:operate`
- scheduler: User principal を持たない system 処理。ただし有効化済み target だけを処理する

SSO group と Mado role の同期方式は変更しない。

## 監査ログ

現在の「成功した実変更だけを保存する」方針を維持する。

記録するもの:

- 追跡の有効化 / 無効化
- interval の実変更
- User が新しい手動走査を開始した場合の既存 `storage.scan.start`
- 実行中 job の cancel が成立した場合

記録しないもの:

- 履歴やグラフの閲覧
- 同値設定の保存
- scheduler の定期投入
- snapshot の INSERT / retention cleanup
- 実行中 job への dedup 合流

定期処理の成否は監査ログではなく、target の状態、job、application log で確認する。

## UI

### 配置

bucket root (`prefix === ''`) の Storage 画面で、README の上に「容量の推移」card を表示する。
prefix 内では表示しない。bucket 一覧への現在値の埋め込みは第 2 弾とする。

card の上段:

- 現在容量
- 前回 snapshot との差分と増減率
- object 数
- 最終取得日時
- connection に容量上限があれば使用率

card の下段:

- 期間: 7日 / 30日 / 90日 / 400日
- 容量の折れ線
- object 数の折れ線は切替式。二重 Y 軸にはしない
- 取得点を hover / keyboard focus すると日時と正確な値を表示
- interval の 2.5 倍以上空いた区間は線を切り、未取得期間を補間しない
- `partial` や error はデータ点にせず、card 上部に状態として表示

データがない場合は空の chart を描かず、「履歴はまだありません」と最終状態を表示する。

### 操作

- `jobs:operate` を持つ User: 「今すぐ更新」
- `connections:manage` を持つ User: 追跡 toggle と周期 select
- 権限がない User: 設定値と graph だけを表示
- `scan_enabled = false`: 更新操作を隠し、「この接続では走査が無効です」と表示
- queued / running: 既存 job UI と同じ進捗を表示し、完了後に履歴を再取得

### graph 実装

第 1 弾は chart library を追加せず、React + SVG で実装する。

- 1 系列、最大 1,600 点なので描画要件は単純
- `<svg role="img">`、`<title>`、軸 label を持たせる
- 最新値と差分は graph 外の text でも提供する
- point の詳細は pointer だけでなく keyboard focus でも読めるようにする
- Y 軸は表示範囲の最小 / 最大へ padding を持たせ、軸の下限値を明記する
- 容量上限が設定されていれば水平線で表示する

zoom、複数 bucket 比較、annotation 等が必要になった時点で `uPlot` 等の軽量 library、または
Grafana を検討する。単純な 1 系列のためだけに初期 bundle と依存を増やさない。

## エラーと縮退

- `ListObjects` の途中失敗: `partial` とし snapshot を保存しない
- credential / endpoint error: target に正規化した error を表示し backoff
- bucket が空: `0 bytes / 0 objects` の正常 snapshot
- worker 停止: 現行 stale job 復旧後に再開。scheduler は `next_run_at` から取り戻す
- DB 停止: job loop と同様に process を落とさず再試行
- schedule backlog: 1 worker で古い順に処理。時刻どおりでない点は実際の `collected_at` へ記録
- tracking 無効化中に job が実行中: job は自動 cancel しない。完了 snapshot は保存し、次回だけ止める
- connection 削除: target / snapshot は cascade 削除

## 性能と費用

1 bucket、1 日 1 回、547,259 objects の場合、`MaxKeys=1000` で約 548 LIST request / day。
全 bucket を自動登録せず明示 opt-in にすることで、導入直後の request 増加を 0 にする。

次を application log / 将来の Prometheus metric に出す。

- collection duration
- listed pages / objects
- result bytes
- success / partial / error
- queue wait time

bucket 名と connection id は cardinality が管理可能な範囲だが、object key と error 原文は label にしない。

## Grafana 連携の境界

Grafana が必要になった場合、Mado internal API や PostgreSQL を Grafana から直接読ませない。
代わりに API container の private listener に `/metrics` を追加し、最新 snapshot だけを gauge として
公開する。

```text
mado_storage_bucket_bytes{connection_id="...",bucket="dataset"} 9.92e14
mado_storage_bucket_objects{connection_id="...",bucket="dataset"} 547259
mado_storage_capacity_collection_age_seconds{connection_id="...",bucket="dataset"} 412
mado_storage_capacity_collection_failures{connection_id="...",bucket="dataset"} 0
```

- public OpenLineage host には公開しない
- Prometheus から private network 経由で scrape する
- Grafana は Prometheus の retention を使い、Mado DB の正本履歴とは独立した運用 cache とみなす
- bucket 数が大きくなったら label cardinality と scrape payload を再評価する

## migration と rollout

1. migration で target / snapshot table を追加する
2. API、worker、front を build する
3. migration を適用する
4. API、worker、front を更新する
5. tracking 0 件、定期 job 0 件であることを確認する
6. 小さい bucket 1 件で追跡を有効化し、初回 snapshot と graph を検証する
7. request 数と所要時間を確認してから大きい bucket を個別に有効化する

新規 table だけの additive migration であり、既存 Storage 閲覧と走査 APIを止めずに適用できる。
rollback 時は UI / scheduler を旧 image へ戻す。追加 table は直ちに削除せず、再 deploy に備えて残す。

## テスト

### API / DB

- target の interval 下限 / 上限、FK、cascade、due index
- snapshot は同じ job id で二重作成されない
- root の完全走査だけが snapshot になる
- prefix 走査、partial、cancel、error は snapshot にならない
- tracking enable / disable / interval変更と同値更新
- `scan_enabled = false` で enable が拒否される
- 7 / 30 / 90 / 400 日の境界と時系列順
- ACL 非許可 User は 404、list capability 無効は 403
- snapshot 閲覧が audit に入らず、設定の実変更だけが入る
- 400 日より古い点だけを prune する

### scheduler / worker

- due target だけを投入する
- 同一 bucket の実行中 job へ合流する
- 成功時に interval 後、partial / error 時に backoff される
- scheduler 再起動後も `next_run_at` から取り戻す
- 複数 scheduler loop が動いても active job が二重にならない
- secret を error / log に残さない

### front

- snapshot なし、1 点、複数点、gap、0 bytes
- 期間切替
- 容量、object 数、差分、使用率の表示
- permission ごとの操作表示
- tracking、手動更新、job 完了後の再取得
- keyboard で point 詳細を確認できる
- narrow viewport で横 overflow しない

## 受け入れ確認

1. deploy 直後に tracking / job が自動作成されない
2. 小さい bucket を 24 時間周期で有効化すると root 走査が 1 件投入される
3. 完了後、容量と object 数の snapshot が 1 点追加される
4. 「今すぐ更新」で既存 job UI に進捗が出て、完了後に 2 点目が追加される
5. prefix の手動走査では容量履歴が増えない
6. partial 走査では graph に誤った点が追加されない
7. allowlist 外 Userには API / UI のどちらからも対象 connection が見えない
8. tracking 無効化後は履歴を読めるが、新規の定期 job は作られない
9. 更新された設定と手動 job start だけが監査ログに入り、閲覧と定期 snapshot は入らない
10. 既存11 serviceと公開OpenLineage APIに回帰がない

## 将来の拡張

- bucket 一覧への最新容量、前日比、鮮度の表示
- provider 固有 collector
- 週次 / 月次増加量と満杯予測
- 急増、急減、取得停止の通知
- 複数 bucket / connection の比較画面
- Prometheus exporter と Grafana dashboard
- prefix / Dataset 単位の明示的な追跡。bucket と同じ表へ安易に混在させず、走査費用と cardinality を再設計する
