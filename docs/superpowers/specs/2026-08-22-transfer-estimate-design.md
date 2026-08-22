# 転送先ごとの費用・所要時間の見積もり

## 背景

社内で使えるオブジェクトストレージは特性がばらばらである。速いが接続が不安定なもの、遅いが容量が余っているもの、堅いが高いもの。「このディレクトリをどこへ置くべきか」は毎回この 3 つを頭の中で突き合わせて決めており、判断の材料は人によって違う。

Mado は既に接続を横断して見られるが、**接続の違いを「見比べられる形」にはしていない**。エンドポイントと権限トグルしか持っておらず、速度もコストも容量も画面には無い。

一方で Mado は、この判断に必要な材料を既に片方だけ持っている。走査 (`storage.scan`) が返す `objectCount` と `totalBytes` である。一般の料金計算ツールは「何 GB か」しか受け取らないので、**オブジェクト数に比例するコスト (リクエスト料金) と、オブジェクト数が律速になる所要時間を計算できない**。Mado はこれができる。

そこで、走査済みのディレクトリに対して「登録済みの各接続へ移した場合の費用と所要時間」を並べて出す。

## 目的

- 走査済みディレクトリについて、**登録済み接続それぞれへ移した場合**の初期費用・月額・所要時間を一覧で比較できる
- AWS S3 はストレージクラスを選べる (Standard / IA / Glacier 系)。クラスによって月額もリクエスト料金も最小保存期間も変わるため、クラスは接続の設定項目とする
- 費用の内訳を出す。特に **移動元から出す費用 (egress)** を隠さない。移動先の月額だけを見て決めると桁を間違える
- 見積もりの前提 (単価・帯域・料金表の取得日) を画面から辿れる

## 非目標

- **転送の実行**。この仕様は見積もりだけを扱う。実行は Mado がデータの通り道になるかどうかという別の判断を伴うので分ける
- **AWS 以外からの egress**。社内ストレージ (mdx / jamstec) は egress の概念を持たないため 0 とする。Wasabi は egress 無料 (ただし後述の 1:1 制限を警告として出す)
- **Azure Blob Storage**。料金モデルの軸 (アクセス層 × 冗長性 × リージョン) が多く、実装コストが跳ねる。プロバイダを列挙型にしておき後から足せる形にはする
- **請求額の再現**。目的は桁と大小関係を合わせることであって、実際の請求書と一致させることではない。無料枠・Savings Plans・既存の月間使用量との合算は考慮しない
- **料金表の取得を必須にすること**。外向き通信が塞がれた環境でも、同梱カタログで見積もりは出る。取得は「あれば新しくなる」ものであって、前提ではない
- **定時実行**。Mado にスケジューラは無い。更新は手動と、見積もりを開いたついでの自動 (後述) の 2 つだけ

## 料金カタログ

### 同梱 + DB キャッシュ

料金は実行時に取りに行き、DB にキャッシュする。同梱のカタログはその**初期値と
フォールバック**であって、唯一の出所ではない。

| 層 | 役割 |
| --- | --- |
| プロセス内メモリ | 60 秒。`/estimate` のたびに DB を引かないため |
| `pricing_cache` (DB) | 取得したカタログ。1 行だけ持つ |
| 同梱 `api/pricing/catalog.ts` | 取得したことが無い / 取得に失敗し続ける場合の土台 |

**取得できない環境で壊れないことを最優先にする。** Mado は LAN 内で完結する前提の
ツールであり、外向きの通信が塞がれている環境も想定される。その場合でも同梱
カタログで見積もりは出る — 「単価が引けない」ことと「無料である」ことを取り違え
させないため、UI には出所 (同梱 / 取得日) を必ず出す。

### 更新のしかた

- **手動**: 見積もり画面と Settings の「単価を更新」。`pricing.refresh` ジョブを投入する
- **自動**: `/estimate` を叩いたとき、キャッシュが `pricing_refresh_days` (既定 1 日)
  より古ければ**裏でジョブを投入する**。その回の見積もりは古い単価のまま返す
  (stale-while-revalidate — 一覧キャッシュと同じ考え方)。更新は次回から効く
- **オフライン**: 取得スクリプトを手で回して同梱カタログを更新し、PR にする

自動更新を stale-while-revalidate にしたのは、料金の取得 (外部 HTTP 2 往復) を
見積もりの応答時間に載せないため。料金改定は年 1〜2 回であり、1 回分古い単価で
出しても桁は変わらない。

ジョブ基盤に載せるのは、外部 HTTP がハングしたときに HTTP リクエストを道連れに
しないためと、`jobs_active` の部分ユニークインデックスが同時実行の合流を
勝手にやってくれるため (複数人が同時に更新を押しても 1 本になる)。

```sql
-- 020_pricing_cache.sql
CREATE TABLE pricing_cache (
  id         BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),  -- 常に 1 行
  catalog    JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`取得ロジック: api/lib/pricing-fetch.ts` (ジョブと取得スクリプトが共有する)
`取得スクリプト: api/scripts/fetch-pricing.ts` — 同梱カタログを書き出す

### 単価の出所を持つ

**「単価を更新」で新しくなるのは AWS の単価だけである。** 料金 API から取れない値がいくつもあり、それらは取得しても変わらない。取得日 (`asOf` / `fetchedAt`) だけを画面に出すと、Wasabi の行まで API から取れた新しい値に見えてしまう。

そこで単価に出所を持たせる。

| 値 | 意味 |
| --- | --- |
| `api` | AWS の料金 API から取得。更新で新しくなる |
| `proxy` | 料金 API に無いので同額の別クラスの API 値で代用 (Deep Archive) |
| `manual` | 料金 API が無く、Mado が公表値を焼いている (Wasabi)。**更新しても変わらない** |
| `override` | その接続の設定で人が入れた値。本人が入れたので注記は要らない |
| `none` | 費用の概念が無い接続 (社内ストレージ) |

`manual` と `proxy` には候補の行を開いたときに注記を出す。加えて、カタログ全体に `manualFacts` を持たせ、「何を手で持っているか・いつ一次ソースで確認したか・出典はどこか」を見積もり画面の脚注 (既定は折りたたみ) に出す。

`manual` の値には接続ごとの単価上書き (`cost.storage_per_gb_month`) で実際の契約単価を入れられる。UI にも出す。

### Glacier Deep Archive の単価について

`AmazonS3` の Price List には **Glacier Deep Archive のストレージ単価そのものが存在しない** (取り出し・ライフサイクル遷移リクエストはある)。カタログでは Intelligent-Tiering の Deep Archive Access 層の単価 (`TimedStorage-INT-DAA-ByteHrs`) を代理値として使う。

この代理が妥当であることは、単価が公表されている us-east-1 で確認できる。同層は $0.00099/GB-Mo であり、Deep Archive の公表単価と一致する。同様に Archive Access 層 ($0.0045) は Glacier Flexible Retrieval と、Archive Instant Access 層 ($0.005) は Glacier Instant Retrieval と一致する。

カタログではこの値の出所を `proxy` とし、UI では候補の行に注記を出す。

### 取得済みの値 (ap-northeast-1 / 2026-08-18 版)

ストレージ ($/GB-月):

| クラス | 単価 |
| --- | ---: |
| Standard | 0.025 (〜50TB) / 0.024 (〜500TB) / 0.023 |
| Standard-IA | 0.0138 |
| One Zone-IA | 0.011 |
| Glacier Instant Retrieval | 0.005 |
| Glacier Flexible Retrieval | 0.0045 |
| Glacier Deep Archive | 0.002 (代理値) |
| Intelligent-Tiering (Frequent) | 0.025 / 0.024 / 0.023 |

リクエスト ($/1000) と取り出し ($/GB):

| クラス | PUT | GET | 取り出し |
| --- | ---: | ---: | ---: |
| Standard | 0.0047 | 0.00037 | — |
| Standard-IA | 0.01 | 0.001 | 0.01 |
| One Zone-IA | 0.01 | 0.001 | 0.01 |
| Glacier IR | 0.02 | 0.01 | 0.03 |
| Glacier FR | 0.03426 | 0.00037 | 0.011 (Standard) / 0.033 (Expedited) / 0 (Bulk) |
| Glacier DA | 0.065 | 0.00037 | 0.022 (Standard) / 0.005 (Bulk) |

egress (インターネット向け、段階制):

| 帯 | 単価 |
| --- | ---: |
| 最初の 100GB/月 | 無料 |
| 〜10TB | 0.114 |
| 10〜50TB | 0.089 |
| 50〜150TB | 0.086 |
| 150TB〜 | 0.084 |

最小保存期間 / 最小課金サイズ / オブジェクトごとの加算 (料金 API に無いドキュメント値):

**最小課金サイズと加算は別物である。** 前者は「これ未満のオブジェクトもこのサイズとして課金する」、後者は「どのサイズのオブジェクトにも上乗せする」。Glacier 系の 40KB を最小課金サイズとして扱うと、大きいオブジェクトぶんの加算が丸ごと落ちる。

| クラス | 最小期間 | 最小課金サイズ | 加算 |
| --- | ---: | ---: | ---: |
| Standard / Intelligent-Tiering | — | — | — |
| Standard-IA / One Zone-IA | 30 日 | 128 KB | — |
| Glacier IR | 90 日 | 128 KB | — |
| Glacier FR | 90 日 | — | 40 KB |
| Glacier DA | 180 日 | — | 40 KB |

40KB の内訳は 8KB (Standard 料金) + 32KB (Glacier 料金) だが、単価を分けるほどの額ではないので 40KB 全部を同クラスの単価で数える。

Wasabi:

- $7.99/TB/月 (2026-07-01 改定。それ以前は $6.99)
- egress・API リクエストとも無料。ただし月間ダウンロード量が保存量を超えると制限対象 (1:1 ポリシー)
- 最小保存期間 90 日、最小課金 1TB/月

## 接続プロファイル

**マイグレーションは不要。** `connection_settings` (013) が接続ごとの key/value を既に持っているので、そこにキーを足すだけで済む。`cap.` が権限専用の接頭辞であるのと同じく、見積もり用のキーも接頭辞で名前空間を切る。

| キー | 既定 | 意味 |
| --- | --- | --- |
| `provider` | エンドポイントから推定 | `aws` / `wasabi` / `onprem` / `other` |
| `pricing.region` | 接続の `region` | カタログのリージョンキー |
| `pricing.storage_class` | `STANDARD` | 書き込み先のストレージクラス |
| `perf.read_mbps` | プロバイダ既定 | 読み出しの実効帯域 (MB/s) |
| `perf.write_mbps` | プロバイダ既定 | 書き込みの実効帯域 (MB/s) |
| `perf.parallelism` | 16 | 想定する並列転送数 |
| `perf.request_overhead_ms` | 20 | 1 オブジェクトあたりの固定コスト |
| `perf.instability` | 0.5 | 悲観側の上振れ率。接続が不安定なほど大きく |
| `cost.storage_per_gb_month` | カタログ | 手動上書き |
| `cost.egress_per_gb` | カタログ | 手動上書き (段階制を潰した定額) |
| `cost.put_per_1000` | カタログ | 手動上書き |
| `cost.get_per_1000` | カタログ | 手動上書き |
| `capacity.total_bytes` | — | 容量上限。`onprem` の残容量表示に使う |

`provider` の推定はエンドポイントのホスト名で行う。推定結果は設定画面に出し、間違っていれば手で直せる。

```
*.amazonaws.com    → aws
*.wasabisys.com    → wasabi
それ以外            → onprem
```

`onprem` はコスト 0 として扱う。社内ストレージの実費は Mado の関知するところではなく、0 と表示することで「金は掛からないが容量は有限」という実際の判断軸に寄せる。

## 計算モデル

`api/lib/transfer-estimate.ts` に純関数として置く。S3 も DB も知らない。入力は走査結果と両端のプロファイルだけであり、これによりテストは全て単体で書ける (`scan.ts` と同じ方針)。

### 所要時間

帯域律速とオブジェクト律速の**大きい方**を採る。並列転送では両者は同時に進行するため、和ではなく max が実態に近い。

```
t_bandwidth = totalBytes / min(src.readMbps, dst.writeMbps)
t_requests  = objectCount × requestOverheadMs / parallelism
t_optimistic = max(t_bandwidth, t_requests)
t_pessimistic = t_optimistic × (1 + max(src.instability, dst.instability))
```

**時間は必ずレンジで出す。** 単一の数字を出すと外れたときに機能全体が信用されなくなる。悲観側はリトライと接続断の取り戻しを織り込む。

平均オブジェクトサイズが小さいときに `t_requests` が支配的になるのがこのモデルの要点である。40TB を 137,757 個で持つ場合は帯域律速だが、同じ 40TB を 4,000 万個で持つなら律速はリクエスト側に移り、帯域から出した見積もりは桁で外れる。

### 初期費用

```
egress   = 段階制で totalBytes を積分 (移動元が aws のときのみ。無料枠 100GB を引く)
retrieval= totalBytes × src.retrievalPerGb   (移動元が IA / Glacier 系のとき)
getReq   = objectCount × src.getPer1000 / 1000
putReq   = putRequestCount × dst.putPer1000 / 1000
```

`putRequestCount` はマルチパートを考慮する。平均サイズがしきい値を超えると 1 オブジェクトが複数リクエストになる。

```
parts = max(1, ceil(avgBytes / partSizeBytes))
putRequestCount = parts > 1
  ? objectCount × (parts + 2)   // CreateMultipartUpload + N×UploadPart + Complete
  : objectCount
```

`partSizeBytes` は既定 64MiB。平均 295MB のデータセットでは 1 オブジェクトあたり 7 リクエストになり、単純計算の 7 倍になる。Glacier Deep Archive のように PUT が $0.065/1000 と高いクラスでは、この差が効く。

### 月額

```
billableBytes = objectCount × (max(avgBytes, minBillableObjectBytes) + perObjectOverheadBytes)
monthly       = 段階制で billableBytes を積分
```

最小課金サイズと加算は**両方効く**。前者は「これ未満はこのサイズとして課金」、
後者は「どのサイズにも上乗せ」で、別の概念である (前掲の表を参照)。

**最小課金サイズの扱いには既知の弱点がある。** 走査は合計バイト数と個数しか持たないため、平均で近似せざるを得ない。分布が偏っている (大きいファイルと極小ファイルが混在する) 場合、この近似は最小課金サイズの影響を過小評価する。

正しく出すには走査側にサイズのヒストグラムが要る。これは `createScanAccumulator` にバケットを 1 つ足すだけで済むが、既存の走査結果 (`jobs.result`) には無いため、再走査するまで使えない。**この仕様では平均近似で実装し、ヒストグラムは後続とする。** UI では、平均が最小課金サイズを下回る接続に対してのみ「小さいオブジェクトが多く、月額は表示より高くなる可能性がある」と警告を出す。

### 警告

費用と時間の数字だけでは判断を誤るものを、別枠のテキストとして出す。

- 最小保存期間: 「90 日以内に消すと、消した分も 90 日分課金される」
- Wasabi の 1:1 制限: 「月間ダウンロード量が保存量を超えると制限対象」
- Glacier 系への配置: 「取り出しには時間と別料金がかかる」(Deep Archive は Standard 取り出しで $0.022/GB)
- 容量超過: `capacity.total_bytes` を超える場合
- 平均オブジェクトサイズが最小課金サイズ未満
- カタログが古い場合 (取得日から 180 日以上)

## API

```
GET /storage/:connId/estimate?bucket=&prefix=
```

走査済みディレクトリについて、**登録済みの全接続を移動先候補として**見積もった配列を返す。移動元は `:connId` である。

最新の成功した走査 (`jobs` の `latestDone`) を読む。走査が無ければ 409 を返し、UI は「先に走査してください」を出す。走査を投げ直すのはこのエンドポイントの仕事ではない (重い操作を暗黙に起動しない、という走査仕様の方針を踏襲する)。

移動元自身も候補から外さない。「同じ接続の中で別のストレージクラスに変える」が実際の選択肢になりうるため。

```jsonc
{
  "source": { "connId": "...", "name": "mdx-s3", "provider": "onprem" },
  "scan": { "objectCount": 137757, "totalBytes": 44749162086400, "scannedAt": "..." },
  "catalogAsOf": "2026-08-22",
  "candidates": [
    {
      "connId": "...", "name": "jamstec-s3", "provider": "onprem",
      "storageClass": null,
      "durationSec": { "optimistic": 63927, "pessimistic": 95890 },
      "upfront": { "egress": 0, "retrieval": 0, "getRequests": 0, "putRequests": 0, "total": 0 },
      "monthlyUsd": 0,
      "warnings": [{ "kind": "capacity", "message": "..." }]
    }
  ]
}
```

`capabilityGuard` は通さない。見積もりは S3 を一切叩かず、DB の走査結果と設定だけから計算するため、`list` 権限すら不要である。

## UI

走査の内訳モーダル (`ScanModal`) にタブを 1 つ足す。走査結果を見ている文脈がそのまま「で、どこへ移す?」につながるため、新しい導線を作るより既存のモーダルを広げる。

```
┌─ 配下の集計 ───────────────────────┐
│ [ 内訳 ] [ 移送の見積もり ]              │
│                                       │
│  137,757 件 / 40.7 TB   (平均 295 MB)   │
│                                       │
│  移動先          所要      初期    月額   │
│  jamstec-s3    18〜27h      $0      $0   │
│  aws-s3 (Std) 13〜20h    $0.5  $1,043   │
│  aws (Deep)   13〜20h    $65      $83   │
│  wasabi        18〜27h      $0     $357  │
│                                       │
│  ⚠ Deep Archive: 180 日以内の削除は …     │
│  単価 as of 2026-08-22 · 内訳を見る       │
└───────────────────────────────────┘
```

各行を開くと内訳 (egress / 取り出し / リクエスト / ストレージ) が出る。移動元が AWS のときは egress が最上位に来るため、行を閉じたままでも総額に含まれていることが分かるよう、初期費用に `▸` を付ける。

接続の設定は `ConnectionForm` に「転送の見積もり」セクションを足す。既定値で埋まっているので、通常は触らなくてよい。

## テスト

`transfer-estimate.ts` は純関数なので単体で全て書ける。

- 段階制の積分が境界 (50TB ちょうど / 10TB ちょうど) で正しい
- egress の無料枠 100GB が引かれる
- 移動元が `onprem` のとき egress が 0
- 平均サイズが小さいときオブジェクト律速に切り替わる
- マルチパートの PUT 数
- 最小課金サイズが月額に反映される
- 各警告の発火条件
- 手動上書き (`cost.*`) がカタログより優先される

カタログ JSON は形をテストする (必須クラスが揃っている、単価が数値、`asOf` がある)。単価そのものは外部に依存するのでテストしない。
