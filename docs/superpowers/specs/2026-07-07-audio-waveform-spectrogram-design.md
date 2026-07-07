# 音声プレビューの波形 / スペクトログラム表示 + 同期マルチトラック再生

## 背景

チームメンバーから「NVIDIA NeMo の [Speech Data Explorer](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/speech_data_explorer.html) のような機能があったら楽しそう」という提案があった。SDE の主機能はデータセット統計・発話ブラウズ + 再生・波形/スペクトログラム表示・ASR 誤り分析。

ブレインストーミングの結果、第一弾として次の 2 つを作る。発話ブラウズ（WebDataset tar の .wav + .txt ペア化）とデータセット統計は後続の拡張とする（→ [将来拡張](#将来拡張)）。

1. **波形 / スペクトログラム表示** — 既存の音声プレビュー全般に追加
2. **同期マルチトラック再生** — 同一 tar / ディレクトリ内のマルチチャンネル録音（チャンネル別 wav など）を、スタート時間を揃えて同時再生できる画面下部ドックのプレイヤー。トラック数に上限は設けない

前提となるデータ・利用状況:

- 音声データセットは WebDataset 式 tar（.wav + .txt/.json ペア）が中心。規模はまちまち
- プレビュー対象は短い発話が主だが、数十分〜数時間の長尺録音も開く
- 長尺対応のため **サーバー側 ffmpeg でストリーミング解析、フロントは描画のみ** という方針（クライアント側 `decodeAudioData` はフルデコードが必要でメモリ的に不可）
- 短い発話のような **軽いファイルの解析はジョブキューを通さず同期で返す**。キュー + ポーリングは長尺ファイルのみ

## 目的

- 音声ファイル（単体 / tar 内エントリ）のプレビューに波形とスペクトログラムを表示する
- 波形クリックでシークでき、再生ヘッドが追従する
- 長さ・フォーマットによらず一定メモリで解析できる（ストリーミング）
- 短い発話は待ち時間なく波形が出る（同期パス）。解析待ちが再生をブロックしない
- マルチチャンネル録音のチャンネル別ファイルを頭出しを揃えて同時再生・ミュート/ソロで聴き比べできる

## アーキテクチャ

```
Browser ──① analyze 要求──► api-internal
                              │ ② キャッシュ命中? ─ yes ─► 200 (peaks/spectrogram)
                              │ ③ サイズ判定 (HeadObject Content-Length)
                              │
              ┌── 軽い (< MEDIA_SYNC_MAX_BYTES) ──┐   ┌── 重い ───────────────┐
              │ media-worker の内部 HTTP へ proxy │   │ media_jobs に INSERT   │
              │ → その場で解析 → 200 done         │   │ → 202 + status         │
              └──────────────┬──────────────────┘   └──────────┬─────────────┘
                              ▼                                 ▼
                        media-worker (ffmpeg 入り別コンテナ)
                          ・内部 HTTP: 同期解析 (同時 3 まで, 超過は 503 → api がキューへ格下げ)
                          ・ジョブループ: SKIP LOCKED で 1 件ずつ (同時実行 1)
                              │ S3 → stream → ffmpeg
                              │  ・波形ピーク min/max JSON (~2000 点)
                              │  ・スペクトログラム PNG (showspectrumpic)
                              ▼
                        media_cache テーブル (ETag 込みキーで UPSERT)
Browser ◄─ 重いファイルのみ 1 秒ポーリング (queued n 番目 / processing / done / error)
```

### 設計判断

- **軽いファイルは同期パス**。短い発話（大半のユースケース）はポーリングなしの 1 リクエストで波形が返る。ffmpeg を api イメージに入れないため、api → media-worker の内部 HTTP（compose ネットワーク内のみ、ホスト非公開）に proxy する。同期解析の同時実行数を超えたら worker が 503 を返し、api はジョブキューへ格下げして 202 を返す（劣化はキュー待ちになるだけ）
- **ジョブキューは Postgres**（`FOR UPDATE SKIP LOCKED`）。Redis 案と比較したが、新しいステートフルサービスを増やさない・ジョブが再起動を跨いで残る・結果キャッシュ (bytea) も同居できる点で Postgres を採用。追加コンテナは media-worker のみ
- **ffmpeg は api イメージに入れない**。media-worker に隔離し、api イメージは小さいまま。CPU 負荷も分離される
- **同時実行 1** は worker が `LIMIT 1` でしかジョブを取らないことで担保（研究室 LAN の共有インスタンスで解析が資源を食い潰さないため）
- **ストリーミング**: S3 GetObject（tar エントリは既存 `tar-range` で部分読み）→ ffmpeg stdin。フルダウンロード・フルデコード不要でメモリ一定
- **キャッシュキーに ETag を含める** ため、S3 側でファイルが再アップロードされると自然に再解析される

## データモデル

マイグレーションでテーブルを 2 つ追加する。

```sql
-- ジョブキュー
media_jobs (
  id           bigserial PRIMARY KEY,
  cache_key    text UNIQUE NOT NULL,   -- media_cache と同一キー。UNIQUE で同一ファイルのジョブ合流
  payload      jsonb NOT NULL,         -- {connId, bucket, key, entryPath?, etag}
                                       -- tar 内エントリの場合: key = tar のキー, entryPath = tar 内パス
  status       text NOT NULL,          -- queued | processing | done | error
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
)

-- 結果キャッシュ
media_cache (
  cache_key    text PRIMARY KEY,       -- connId:bucket:key(:entryPath):etag
  peaks        jsonb NOT NULL,         -- [[min,max], ...] ~2000 点・数 KB
  spectrogram  bytea,                  -- PNG。幅は上限 4096px にクランプ
  duration_sec real,
  sample_rate  int,
  created_at   timestamptz NOT NULL DEFAULT now()
)
```

- 古いキャッシュ / 完了ジョブは worker が定期削除（例: 30 日経過 or 合計サイズ上限）
- PG ロールは既存方針に従い、ブラウザ経路 (api) は `dashboard_rw`、worker も `dashboard_rw` を使用

## API

`api/routes/storage-media.ts` を新設（`storage-preview.ts` の隣）。エンドポイントは 2 本。

### `GET /storage/:connId/media/analyze?bucket&key(&entryPath)`

- HeadObject で ETag と Content-Length を取得し cache_key を構成
- `media_cache` 命中 → `200 {status:"done", peaks, durationSec, sampleRate, spectrogramUrl}`
- 未計算かつ **軽い** (Content-Length < `MEDIA_SYNC_MAX_BYTES`) → media-worker の内部 HTTP に proxy して同期解析 → 結果を `media_cache` に保存しつつ `200 done` をそのまま返す。worker が 503（同期スロット満杯）ならジョブキューへ格下げ
- 未計算かつ **重い** → `INSERT INTO media_jobs ... ON CONFLICT (cache_key) DO NOTHING` → `202 {status:"queued", position:n}`
- 処理中 → `202 {status:"processing"}`
- 失敗済み → `200 {status:"error", message}`
- GET だが冪等（同一ファイルへの多重投入は UNIQUE で合流）。既存 preview 系と同じ読み取り系エンドポイントとして扱う

### `GET /storage/:connId/media/spectrogram?cacheKey`

- `media_cache.spectrogram` の PNG をそのまま返す（`<img src>` 用）
- `Cache-Control` を長めに付与（キーに ETag 込みのため immutable 扱いにできる）

## media-worker

`api/` と同じ TypeScript コードベースに `worker.ts` を追加し、compose で別サービスとして起動する（dev: `tsx watch worker.ts` / prod: `node dist/worker.js`）。Dockerfile は api と共通ベースに ffmpeg を追加した worker 用ステージを作る。

1 プロセスの中に 2 つの入り口を持つ:

- **内部 HTTP（同期解析）**: compose ネットワーク内のみで listen（ホスト非公開）。api からの proxy を受け、その場で解析して結果を返す。同時実行は `MEDIA_SYNC_CONCURRENCY`（既定 3）まで、超過は 503
- **ジョブループ（非同期解析）**: 以下の通り

処理ループ:

1. `SELECT ... FROM media_jobs WHERE status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`（なければ 1 秒待って再試行）
2. payload から S3 オブジェクト（または tar エントリ）を取得しストリームを開く
3. ffmpeg 2 パス（stdout は 1 本しかないため、パスごとに S3 から再ストリーミング。追加メモリなし・GetObject が 2 回になるだけ）:
   - ピーク: `ffmpeg -i pipe:0 -ac 1 -f f32le pipe:1` の出力を読みながら固定 2000 バケットで min/max 集計（メモリ一定）。総サンプル数から duration_sec も算出
   - スペクトログラム: `ffmpeg -i pipe:0 -lavfi showspectrumpic=s=Wx256 pipe:1` で PNG 生成（高さ 256px 固定）。W は duration に比例させつつ上限 4096px
4. `media_cache` に UPSERT → ジョブを `done` に更新
5. ガード:
   - ジョブごとにタイムアウト 5 分（超過で kill → `error`）
   - ffmpeg 異常終了（非音声ファイル等）は `error` として stderr 要約を記録
   - worker プロセス異常終了で `processing` のまま残ったジョブは、起動時に `queued` へ戻す

## フロントエンド

変更の中心は `front/components/PreviewAudio.tsx` の拡張。props インターフェース（`connId, bucket, k`）は維持し、tar エントリ用に optional な `entryPath` を追加（その場合 `k` は tar のキー）。呼び出し側 (PreviewDrawer / TarEntryModal) の変更は最小。

```
┌──────────────────────────────────┐
│ ▶ 0:04 / 0:12        (既存 <audio>)│
├──────────────────────────────────┤
│  ██▅▂▃▇█▆▃▁▂▅██▇▅▃  波形 canvas    │ ← クリックでシーク / 再生ヘッド追従
├──────────────────────────────────┤
│  ▓▓▒▒░░▒▓▓▒░▒▒▓▓  スペクトログラム │ ← <img> (トグル表示)
└──────────────────────────────────┘
│ 解析中… キュー 2 番目              │ ← 202 の間のプログレス表示
```

- **再生は従来通り即可能**: `<audio>` は既存のストリーミング URL のまま。波形/スペクトログラムは解析完了後に下へ「生えてくる」。キュー待ちが再生をブロックしない
- **ポーリング**: マウント時に `analyze` を呼び、202 の間は 1 秒間隔で再取得。done で描画、error は小さくメッセージ表示。アンマウントで停止
- **波形描画**: ピーク JSON を devicePixelRatio 対応 canvas に描画。色は Tailwind テーマトークンからとりダークモード追従
- **シーク**: canvas クリック位置の比率 × duration → `audio.currentTime`。再生ヘッドは `requestAnimationFrame` で描画
- **スペクトログラム**: サーバー生成 PNG を `<img>` 表示。デフォルトは波形のみ、スペクトログラムはトグル（縦スペース節約）
- ズーム機能は v1 では作らない (YAGNI)
- 軽いファイル（大半の発話）は同期パスで返るため、実際にはプログレス表示を経ずに初回から波形が出る

### 同期マルチトラックプレイヤー（画面下部ドック）

マルチチャンネル録音のチャンネル別ファイルを、スタート時間を揃えて同時再生するためのプレイヤー。

```
┌─ Storage 一覧 / tar エントリ一覧 ──────┐
│ ch1.wav               [▶] [+デッキ]    │ ← 音声ファイルの行に「デッキに追加」
│ ch2.wav               [▶] [+デッキ]    │
├───────────────────────────────────────┤
│ ▼ 同期プレイヤー (3)          [クリア] │ ← 画面下部に常駐 (折りたたみ可)
│ ch1  ▂▅▇▅▂▁▂▅▇▅▂▁  [M][S][✕]          │ ← トラックごとに波形 + ミュート/ソロ/削除
│ ch2  ▁▂▃▂▁▂▃▂▁▂▃▂  [M][S][✕]          │
│ ch3  ▅▇█▇▅▃▂▁▅▇█▇  [M][S][✕]          │
│ [▶ 一括再生] [■] 0:04 ──●────── 1:23   │ ← マスタートランスポート
└───────────────────────────────────────┘
```

- **追加**: EntryTable（ディレクトリ一覧）と tar エントリ一覧の音声行に「デッキに追加」アクション。トラック数の上限は設けない
- **状態管理**: `PlayerDeckContext` をルーティングの外側に置き、Storage 内のページ遷移でもデッキが消えないようにする（リロードでは消えてよい / v1 では永続化しない）
- **同期再生**: 各トラックは既存のストリーミング URL を持つ `<audio>` 要素。マスター再生で全トラックを同時に `play()` し、以後 1 秒ごとにマスター時刻と比較して 50ms 以上ずれたトラックの `currentTime` を合わせ直す（ドリフト補正）。ストリーミングのままなので長尺チャンネルでもメモリ安全。サンプル精度ではないが、チャンネル聴き比べには十分（制約として明記）
- **マスタートランスポート**: 再生 / 一時停止 / 停止（全トラック 0 秒へ）/ マスターシークバー（全トラックの `currentTime` を一斉変更）。トラック長が異なる場合、短いトラックは先に終わるだけ
- **トラック操作**: ミュート / ソロ（ソロ中は他を自動ミュート）/ 個別削除
- **波形**: 各トラックに analyze の結果（ピーク）をコンパクトに表示。マスター再生ヘッドを全トラックに重ねる

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| 非音声ファイルを解析 | ffmpeg 失敗 → `error` 表示。既存の再生 UI には影響なし |
| 同期解析スロット満杯 (worker 503) | api がジョブキューへ格下げ → 202。体験はキュー待ちに劣化するだけ |
| media-worker 停止中の同期解析 | proxy 失敗 → ジョブキューへ格下げ (worker 復帰後に消化) |
| 解析タイムアウト (5 分) | 「このファイルは解析をスキップしました」と表示 |
| worker 停止中 | ジョブが `queued` のまま → フロントはキュー表示を続ける。worker 復帰で消化 |
| S3 側でファイル更新 | ETag が変わり別キーになるため自然に再解析 |
| 解析済み再訪問 | キャッシュ命中で即描画（ポーリングなし） |

## テスト

既存の流儀（vitest、`api/lib/test-fixtures`）に従う。

- **API**: サイズによる同期/キュー振り分け / worker 503 時のキュー格下げ / ジョブ投入 / 同一ファイル合流 (ON CONFLICT) / status 遷移ごとのレスポンス / spectrogram 配信
- **worker**: ピークのバケット化ロジックを純関数として単体テスト。ffmpeg 本体は fixture の小さい wav で統合テスト（CI に ffmpeg が要る点は worker コンテナ内でのテスト実行で回避可）。同期エンドポイントの同時実行制限
- **フロント**: analyze をモックし queued→done 遷移・エラー表示・canvas 描画呼び出し・クリックシークを確認。デッキはトラック追加/削除・ミュート/ソロ・マスター再生で全 `<audio>` の play が呼ばれること・ドリフト補正ロジック（純関数化してテスト）を確認

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `MEDIA_SYNC_MAX_BYTES` | 20971520 (20MiB) | これ未満は同期解析、以上はジョブキュー |
| `MEDIA_SYNC_CONCURRENCY` | 3 | worker の同期解析の同時実行数（超過は 503 → キューへ格下げ） |
| `MEDIA_JOB_TIMEOUT_SEC` | 300 | 1 ジョブの解析タイムアウト |
| `MEDIA_CACHE_MAX_AGE_DAYS` | 30 | キャッシュの保持日数 |
| `MEDIA_SPECTROGRAM_MAX_WIDTH` | 4096 | スペクトログラム PNG の最大幅 (px) |

## 将来拡張

本設計のパイプライン（ジョブキュー + media_cache）を土台に、SDE の残りの機能を段階的に足せる:

1. **発話ブラウズ**: tar プレビューで .wav + .txt/.json をペア化した「発話ビュー」（テキスト列 + 再生ボタン + 波形サムネイル）
2. **データセット統計**: ディレクトリ（シャード群）単位のバックグラウンドスキャンジョブで総時間・発話数・duration 分布・語彙統計を集計
3. **ASR 誤り分析**: manifest に pred_text があれば WER/CER + diff ハイライト
4. **連続再生（流し聴き）**: 一覧を上から順に自動で再生し続けるモード。デッキのトランスポートを流用できる

## ロールバック

- フロント: PreviewAudio の波形部分は追加 UI のみなので、コンポーネントから解析ブロックを外せば従来表示に戻る。デッキは独立コンポーネント + Context なので丸ごと外せる
- バックエンド: media-worker サービスと routes を外し、テーブル 2 つを drop
