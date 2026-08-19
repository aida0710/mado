# ディレクトリ配下のオブジェクト数・サイズの走査

## 背景

一覧はページ単位でしか見えないので、「このディレクトリ配下に何個あって何 TB か」が分からない。実際、`dataset` バケットの内訳を知るのに、2026-08-17 に手元から `s3cmd ls -r` を回して集計する必要があった。その結果が下記で、これはダッシュボードから見られるべき情報である。

| ディレクトリ | キー数 | 容量 |
| --- | ---: | ---: |
| `debug/` | 162,447 | 5.6 TB |
| `vibevoice-cache/` | 137,757 | 40.7 TB |
| `usp/` | 49,012 | 208.0 TB |

## この機能の前身と、そこから引き継ぐ制約

**同種の機能は一度作られ、`9cd6881` で削除されている** (1,386 行)。当時のスキャンは音声データセットの中身の解析で、各ファイルを `GetObject` して duration・サンプルレート・語彙・文字種を集計し、tar の中まで展開していた。

削除の理由は **「UI / ジョブ管理が煩雑だった」**。キュー (`media_jobs`)、進捗ポーリング (`GET /media/scan-status`)、キャンセル (`POST /media/scan-cancel`)、worker のジョブループ、stale ジョブの再投入まであった。

**本仕様はこの反省を最上位の制約として扱う。ジョブキュー・進捗ポーリング・キャンセル API を作らない。**

これが可能なのは、今回の走査が**桁違いに軽い**ため。

| | 旧スキャン (削除済み) | 本仕様 |
| --- | --- | --- |
| 必要な S3 操作 | 各ファイルの `GetObject` | `ListObjects` のみ |
| tar の展開 | 必要 | 不要 |
| `dataset` 全体の所要 | 数時間規模 | 223 秒 (2026-08-17 実測) |

`ListObjects` の応答には `Key` `Size` `LastModified` `StorageClass` が含まれるので、**オブジェクトを 1 つもダウンロードせずに**数とサイズが出せる。

## 目的

- 開いているディレクトリの配下にオブジェクトが何個あり、合計何バイトかを見られる
- 内訳 (サブディレクトリ別・拡張子別) が分かる
- 巨大バケットで事故らないよう、バケット単位で走査を禁止できる

## スコープ外

- **ジョブキュー・進捗ポーリング・キャンセル API**。前身の削除理由そのもの
- **`GetObject` を伴う解析**。音声の duration、テキストの語彙、tar の中身。旧スキャンの領域であり、コストが桁違い
- **任意 prefix の走査**。走査できるのは**いま開いているディレクトリだけ**。README と同じスコープ (「後述: 走査できる対象」)
- **走査の並列化**。v1 では入れない (後述「並列化を見送る理由」)
- **自動再走査**。TTL で勝手に走らせない。重い操作なので明示操作のみ

## 走査できる対象

**いま開いているディレクトリのみ。** README (`GET /readme?bucket=&prefix=`) と同じで、表示中の prefix に対してのみ実行する。

一覧の行の `⋯` メニューから任意のサブディレクトリを走査する導線は**作らない**。理由:

- 一覧に 100 行あれば 100 個の重い操作への入口ができ、誤爆しやすい
- 「どのディレクトリの結果を見ているのか」がモーダル上で曖昧になる
- 見たいディレクトリを開いてから押す、で困る場面がない

API は `bucket` と `prefix` を受け取るので、サーバー側でこの制約を強制することはできない (サーバーは「何が開いているか」を知らない)。これは UI 上の制約である。

**バケット root (`prefix` が空文字) も対象に含む。** バケットを開いている状態は「ディレクトリを開いている」状態と同じで、除外する理由が無い。むしろ `dataset` のような巨大バケットで最も知りたい数字がここにある。上限で打ち切られるが、それは `scan_enabled` と打ち切り表示で扱う。

## 実行方式

`POST /storage/:connId/scan?bucket=&prefix=` が**同期で**列挙を回し、集計して返す。

- `Delimiter` は付けない (フラット列挙)。区切り付きは CommonPrefixes 計算が重く、`dataset` では prefix に関係なく 28〜35 秒かかる。付けなければ 0.095 秒 / ページ
- `MaxKeys` は **1000**。一覧の 100 と違い、ページ数を減らすのが目的
- 上限は **50,000 キー または 30 秒**。先に当たった方で打ち切る
- 打ち切ったら `truncated: true` を返す

実測から逆算した所要時間 (1 ページ約 0.4 秒):

| 配下のキー数 | ページ数 | 所要 |
| ---: | ---: | ---: |
| 1,000 | 1 | 約 0.4 秒 |
| 10,000 | 10 | 約 4 秒 |
| 44,557 | 45 | 約 18 秒 |
| 547,259 | 548 | 約 223 秒 (上限で打ち切られる) |

**大半のディレクトリは数秒で終わる。** 30 秒上限は nginx の `proxy_read_timeout 300s` に対して十分な余裕がある。

## 並列化を見送る理由

同一 prefix の列挙は**原理的に並列化できない**。次ページを取るには前ページの `NextMarker` / `ContinuationToken` が要るため、鎖状に順番待ちになる。

並列化できるのはサブディレクトリ単位で、まず区切り付きで直下を取ってから各サブツリーを並行に回す形になる。`dataset` 全体なら 223 秒 → 約 65 秒 (6 並列時。162,447 キーの `debug/` が律速) と 3.4 倍になるが、v1 では入れない。

- 上限 30 秒で打ち切る設計なので、並列化しても「打ち切られるまでに数えられる量」が増えるだけ
- 恩恵が効くのは巨大バケットだけで、そこはまさに `scan_enabled=false` で塞ぐ対象
- 典型的なディレクトリ (1 万キー = 4 秒) では効果を体感できない
- 前段としてサブディレクトリ一覧が要るが、`dataset` ではそれ自体が 28〜35 秒かかる

**並列化は走査関数の内部実装であり、API もデータ構造も UI も変わらない。後から足しても手戻りが無い。** `dataset` 全体の正確な数字が実際に必要になったときに検討する。

## 結果の中身

同じ 1 回の列挙から取れるものだけを出す。追加の S3 アクセスは発生しない。

```typescript
interface ScanResult {
  objectCount: number
  totalBytes: number
  /** 直下のサブディレクトリ別の内訳。サイズ降順、最大 50 件。 */
  children: Array<{ name: string; objectCount: number; totalBytes: number }>
  /** 拡張子別の内訳。サイズ降順、最大 10 件。拡張子なしは "(なし)"。 */
  extensions: Array<{ ext: string; objectCount: number; totalBytes: number }>
  /** 上限に達して打ち切ったか。 */
  truncated: boolean
  /** 途中で S3 エラーが出たが、そこまでの集計を返しているか。 */
  partial: boolean
}
```

サイズ分布 (最大ファイル top N、ヒストグラム)、更新時刻の分布、ストレージクラス別の内訳も同じ列挙から取れるが、第 1 弾には含めない。第 2 弾で追加する。

## データの持ち方

一覧キャッシュ (`storage_response_cache`) は**再利用しない**。寿命も無効化条件も違うため、専用テーブルを作る。

`db/migrations/017_storage_scan_results.sql`:

```sql
CREATE TABLE IF NOT EXISTS storage_scan_results (
  conn_id    TEXT        NOT NULL,
  bucket     TEXT        NOT NULL,
  prefix     TEXT        NOT NULL,
  result     JSONB       NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conn_id, bucket, prefix)
);

ALTER TABLE storage_scan_results OWNER TO dashboard_rw;
GRANT SELECT ON storage_scan_results TO dashboard_ro;
```

`GET /storage/:connId/scan?bucket=&prefix=` は保存済みの結果を返す (無ければ 404)。モーダルを開いたら**まず保存済みを表示**し、無ければ走査を促す。`↻` で再走査する。

**TTL を持たせない。** 走査は重い操作なので、期限切れをきっかけに勝手に走らせない。結果には `scanned_at` を出し、「2026/08/18 16:14 に走査」と鮮度をユーザーに判断させる。

## バケット設定

設定は現在 `app_settings` (全体) と `connection_settings` (接続ごと) の 2 階層で、バケット単位が無い。`connection_settings` と同じ key/value 形式で追加する。

`db/migrations/018_bucket_settings.sql`:

```sql
CREATE TABLE IF NOT EXISTS bucket_settings (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, key),
  CHECK (length(key) BETWEEN 1 AND 64)
);

ALTER TABLE bucket_settings OWNER TO dashboard_rw;
GRANT SELECT ON bucket_settings TO dashboard_ro;
```

| key | 既定 | 用途 |
| --- | --- | --- |
| `scan_enabled` | `true` | `false` なら走査ボタンを出さず、API も 403 で止める |
| `list_cache_ttl_sec` | `86400` | 一覧キャッシュの TTL。更新の激しいバケットは短く |

`scan_enabled` は UI で隠すだけでなく **API 側でも 403** にする。共有 URL を直に叩けるため、UI を隠すだけでは意味がない (`connection_capabilities` と同じ考え方)。

止めるのは **`POST` (走査の実行) だけ**。`GET` (保存済み結果の閲覧) は通す。`scan_enabled=false` は「重い走査を新たに走らせない」ためのガードであって、過去に取った結果を隠す意味は無い。バケットを禁止に切り替えた後も、それ以前の集計は読めるべきである。

`list_cache_ttl_sec` は `storage-cache.ts` の `set` が参照する。未設定なら現状どおり 24 時間。

Settings 画面はバケット一覧から各バケットの設定を開く形にする。

## UI

**モーダル。** バナー付近の「配下を集計」ボタンから開く。

- 開いた直後に保存済みの結果があれば表示、無ければ「まだ走査していません」
- 走査中はスピナー。**モーダルの外は通常どおり操作できる** (更新中に一覧を塞がないのと同じ方針)
- モーダルを閉じたら `AbortController` で fetch を中断する
- 結果には `scanned_at` と、`truncated` / `partial` のときは断りを添える

打ち切り時の表示は「**50,000 件以上 / 集計は途中まで**」とする。「50,000 件」と言い切らない。

## 二重起動の扱い

同じ prefix に対する走査が同時に走っても**壊れない**。結果は `(conn_id, bucket, prefix)` で UPSERT されるので、後に終わった方が勝つだけである。

そのうえで、UI 側では走査中に実行ボタンを `disabled` にして通常の二重押しを防ぐ。サーバー側の排他 (in-flight 集約やアドバイザリロック) は入れない。走査は明示操作でしか始まらず、対象は「開いているディレクトリ」に限られるため、複数人が同時に同じ prefix を走査する確率は低い。重複しても余計な S3 リクエストが出るだけで、実害は無い。

実際に問題になるようなら、一覧キャッシュと同じく `pg_advisory_xact_lock` で 1 本に絞る。

## エラーと縮退

走査中に S3 がエラーを返したら、**そこまでの集計を `partial: true` で返す**。数十万キーを数えた後に 1 ページの失敗で全部捨てるのは損。

結果の保存に失敗しても走査結果は返す (一覧キャッシュと同じ「壊さない」方針)。

## テスト

- `api/lib/scan.ts` の集計ロジック — 純関数として、キー配列から `ScanResult` を組み立てる部分を単体テスト。上限打ち切り、拡張子の抽出 (`.tar.gz` の扱い)、直下のサブディレクトリ判定
- ルート — `aws-sdk-client-mock` でページングを模擬し、複数ページの集計、上限での打ち切り、途中エラーでの `partial`、`scan_enabled=false` での 403
- `bucket_settings` の読み書き
- フロント — モーダルの状態遷移 (未走査 / 走査中 / 結果あり / 打ち切り)、閉じたら abort されること

## 受け入れ確認

本番で以下を確認する。

1. 小さいディレクトリ (`trash` 等) を走査 → 1 秒未満で数とサイズが出る
2. `dataset/podcast/` を走査 → 数十秒以内に完了、または打ち切り表示
3. `dataset` バケットで `scan_enabled=false` にする → ボタンが消え、API を直に叩いても 403
4. モーダルを走査中に閉じる → リクエストが中断される (api ログで確認)
5. 走査中に一覧を操作できる

## 将来の拡張

- **走査の第 2 弾**: サイズ分布、更新時刻の分布、ストレージクラス別の内訳。同じ列挙から取れる
- **並列化**: サブディレクトリ単位。上記「並列化を見送る理由」を参照
- **一覧への埋め込み**: ディレクトリ行に件数を出す。ただし 100 行 = 100 走査になるので、走査済みのものだけ表示する等の工夫が要る
