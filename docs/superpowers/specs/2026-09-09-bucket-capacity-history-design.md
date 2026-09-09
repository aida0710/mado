# バケット容量履歴と推移グラフ

> **2026-09-10 改訂:** 追跡対象・周期・手動実行をbucket単位からconnection単位へ変更した。
> 容量画面は全bucketを同時表示し、各bucketの指標・小型graphとconnection全体の合計を出す。
> 周期設定はconnection編集画面へ置き、設定変更と全bucket強制実行はどちらも
> `connections:manage`を必須とする。本書内でこれと矛盾する旧bucket単位の記述は本改訂で置き換える。

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

- **追跡対象**: 定期走査を明示的に有効化した `connection_id`。配下の全bucketを対象とする
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

1. `enabled = true AND next_run_at <= now()`のconnection設定を古い順に最大5件読む
2. connection の `scan_enabled` を確認する。false なら投入せず `paused` とする
3. `ListBuckets`で現行bucketを取得し、新しいbucketも対象へ同期する
4. 全bucketの`storage.scan`をrootのdedup keyで`enqueueWithResult`する
5. 各targetに`last_job_id`を保存し、connectionの次回時刻を進める
6. 同じjobがすでに実行中ならそのidを採用する

定期 job は既存の単一 worker queue へ入るので、S3 request が bucket 数だけ並列に発生しない。
将来 worker を水平 scale する場合は、容量走査専用の concurrency limit を追加するまで
`storage.scan` を処理する worker は 1 replica に保つ。

### 次回実行と失敗時 backoff

- 一括投入成功: connectionの`next_run_at = now() + interval`
- `ListBuckets`や一括投入自体のerror: connectionの`consecutive_failures`を増やし、
  `15 min × 2^(n-1)`、最大6時間で再試行
- 個別bucketのpartial / error: snapshotを保存せずtargetへ状態を残す。connection全体の
  次回実行時には、ほかのbucketと合わせて再投入する
- 3回以上連続失敗しても自動で無効化しない。最大6時間backoffを続ける
- 一括投入成功時にconnectionの`consecutive_failures = 0`と`last_error = NULL`へ戻す

endpoint の一時障害で 24 時間待つことを避けつつ、恒久的な認証失敗で連打しない。
error message は secret、access key、署名済み URL、object key を保存せず、正規化した分類と
短い説明だけを保持する。

## データモデル

次の migration 番号は実装時点の最新番号に合わせる。

```sql
CREATE TABLE storage_capacity_settings (
  connection_id        TEXT PRIMARY KEY
      REFERENCES storage_connections(id) ON DELETE CASCADE,
  enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  interval_seconds     INTEGER NOT NULL DEFAULT 86400
      CHECK (interval_seconds BETWEEN 21600 AND 604800),
  next_run_at          TIMESTAMPTZ,
  last_attempt_at      TIMESTAMPTZ,
  last_status          TEXT NOT NULL DEFAULT 'paused',
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID REFERENCES auth_users(id) ON DELETE SET NULL
);

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

CREATE INDEX storage_capacity_settings_due
  ON storage_capacity_settings(next_run_at)
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
- connection 削除時は credential と同じ単位でsettings / target / snapshotもcascade削除する
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
GET /api/internal/storage/:connId/capacity?days=90
```

- `days`: `7 | 30 | 90 | 400`、既定 90
- S3の現行bucket一覧と全bucketの時系列を1応答で返す
- 各時系列は`collectedAt`昇順
- snapshotがないbucketも`points: []`として返す

```json
{
  "tracking": {
    "enabled": true,
    "intervalSeconds": 86400,
    "nextRunAt": "2026-09-10T00:00:00Z",
    "lastAttemptAt": "2026-09-09T00:00:00Z",
    "lastStatus": "queued",
    "lastError": null,
    "consecutiveFailures": 0
  },
  "capacityBytes": 1099511627776000,
  "buckets": [
    {"bucket": "dataset", "lastStatus": "success", "lastError": null, "points": [
      {"collectedAt": "2026-09-08T00:04:01Z", "totalBytes": 992137445572608, "objectCount": 547259}
    ]}
  ]
}
```

`capacityBytes` は connection の既存 `capacity.total_bytes` 設定で、未設定なら `null`。

### 追跡設定

connection編集APIの一部として保存する。

```json
{"capacityTracking": {"enabled": true, "intervalSeconds": 86400}}
```

- body は strict schema
- 同値更新は DB を変更せず、監査 intent も破棄する
- 無効化しても既存 snapshot は削除しない
- 再有効化時は `next_run_at = now()`
- `scan_enabled = false` の connection では有効化を400で拒否する

### 手動更新

```http
POST /api/internal/storage/:connId/capacity/scan
```

現在存在する全bucketを列挙し、既存`storage.scan` jobへ一括投入する。個別bucketを選んで
容量メトリクスを更新する操作は提供しない。dedupに合流しただけなら監査intentを破棄する。

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
- 全bucketの強制計測: `connections:manage`
- scheduler: User principalを持たないsystem処理。ただし有効化済みconnectionだけを処理する

SSO group と Mado role の同期方式は変更しない。

## 監査ログ

現在の「成功した実変更だけを保存する」方針を維持する。

記録するもの:

- connection更新として行われた追跡の有効化／無効化、intervalの実変更
- Userが新しい全bucket走査を開始した場合の`storage.capacity.scan.start`
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

connection単位の専用画面`?view=capacity`に「バケット容量メトリクス」を表示し、現行の
全bucketを縦に並べる。connectionトップとbucket root (`prefix === ''`) のREADME直下へ
この画面のリンクを置く。prefix内ではリンクを表示しない。

画面上段のconnection合計:

- 計測済みbucketの現在容量合計
- 計測済みbucketのobject数合計
- `計測済みbucket数 / 全bucket数`。未計測があれば合計が部分値だと明示する

各bucketのcompact card:

- bucket名
- 現在容量
- 前回 snapshot との差分と増減率
- object 数
- 最終取得日時
- 高さ150pxの容量折れ線
- 取得点を hover / keyboard focus すると日時と正確な値を表示
- interval の 2.5 倍以上空いた区間は線を切り、未取得期間を補間しない
- `partial`やerrorはデータ点にせず、card内の状態として表示

期間の7日／30日／90日／400日は全cardへ一括適用する。データが2点未満なら空chartを描かない。

### 操作

- `connections:manage`を持つUser: 「今すぐ全バケットを計測」とconnection編集画面の追跡toggle／周期select
- 権限がないUser: 設定値、合計、各bucketの指標とgraphだけを表示
- `scan_enabled = false`: 強制計測をdisabledにする
- 周期設定は容量画面に置かず、connectionの他の動作設定と同じ編集画面に置く

### graph 実装

第 1 弾から **Recharts v3** を使用する。Mado の React 19 構成に対応し、期間切替、tooltip、
responsive layout、基準線を declarative に実装できるため、自前 SVG より保守しやすい。
`recharts` と同じ React 19 系の `react-is` を production dependency に追加する。

主な component と設定:

- `LineChart responsive`: container 幅に追従。親要素には明示的な高さと最小幅を与える
- `XAxis type="number" scale="time"`: `collectedAt` の epoch milliseconds
- `YAxis`: 表示範囲の最小 / 最大へ padding を持たせ、軸の下限値を明記する
- `CartesianGrid`: Mado の color token を使った薄い補助線
- `Tooltip`: JST日時、正確な容量、object 数を表示する custom content
- `Line type="linear"`: 観測点間を直線で結ぶ。実測していない曲線を描かない
- `ReferenceLine`: connection に容量上限が設定されている場合の水平線
- `isAnimationActive={false}`: 最大 1,600 点の再描画を安定させ、測定値の変化を演出で歪めない

欠測は、隣接 snapshot が設定 interval の 2.5 倍以上離れた位置へ `null` の synthetic point を
挿入し、`connectNulls={false}` で線を切る。取得できなかった期間を補間して正常に見せない。

Recharts の `accessibilityLayer` は有効のまま使用する。ただし chart だけを情報源にせず、最新値と
差分は graph 外の text でも提供し、全 snapshot を日時順に読める screen-reader 用 table を置く。
tooltip は pointer と keyboard の双方で確認できることを component test と実 browser で検証する。

Recharts は現在の front には無い比較的大きな依存群を持つため、`BucketCapacityChart` を
`React.lazy` で別 chunk にし、snapshot が2点以上ある bucket root でだけ読み込む。導入時は
Vite の production build 出力を変更前後で比較し、main chunk に Recharts が混入していないことを
確認する。version は lockfile で固定し、依存監査の対象に含める。

zoom、複数 bucket 比較、annotation 等が必要になった時点で Recharts の `Brush` / 同期 chart、
または Grafana を検討する。別の chart library へ同時に依存しない。

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
connection単位の定期計測を初期状態で無効にすることで、導入直後のrequest増加を0にする。
旧bucket単位の追跡設定が存在しても、対象範囲が全bucketへ広がるmigrationでは自動的に
有効化しない。周期だけを引き継ぎ、管理者がconnection設定から明示的に再有効化する。

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

1. migration でconnection設定tableを追加し、既存のtarget / snapshot tableと接続する
2. API、worker、front を build する
3. migration を適用する
4. API、worker、front を更新する
5. tracking 0 件、定期 job 0 件であることを確認する
6. 小規模なconnectionで追跡を有効化し、全bucketの初回snapshotとgraphを検証する
7. request数と所要時間を確認してから大規模なconnectionで有効化する

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

- due connection の全bucketだけを投入する
- 同一 bucket の実行中 job へ合流する
- 一括投入成功時にinterval後、bucket一覧取得や一括投入のerror時にbackoffされる
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
- Recharts の accessibility layer と screen-reader 用 table の内容が snapshot と一致する
- chart component が別 chunk になり、graph のない画面で読み込まれない
- narrow viewport で横 overflow しない

## 受け入れ確認

1. deploy 直後に tracking / job が自動作成されない
2. 小さい bucket を 24 時間周期で有効化すると root 走査が 1 件投入される
3. 完了後、容量と object 数の snapshot が 1 点追加される
4. 「今すぐ全バケットを計測」で既存 job UI に進捗が出て、完了後に 2 点目が追加される
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

## 関連資料

- [Recharts: Chart size](https://recharts.github.io/en-US/guide/sizes/)
- [Recharts: Line](https://recharts.github.io/en-US/api/Line/)
- [Recharts: ReferenceLine](https://recharts.github.io/en-US/api/ReferenceLine/)
- [Recharts npm package](https://www.npmjs.com/package/recharts)
