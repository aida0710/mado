# 音声プレビューの波形 / スペクトログラム表示 + 同期マルチトラック再生 + データセットスキャン

## 背景

チームメンバーから「NVIDIA NeMo の [Speech Data Explorer](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/tools/speech_data_explorer.html) のような機能があったら楽しそう」という提案があった。SDE の主機能はデータセット統計・発話ブラウズ + 再生・波形/スペクトログラム表示・ASR 誤り分析。

ブレインストーミングの結果、第一弾として次の 3 つを作る。発話ブラウズ（WebDataset tar の .wav + .txt ペア化ビュー）と ASR 誤り分析は後続の拡張とする（→ [将来拡張](#将来拡張)）。

1. **波形 / スペクトログラム表示** — 既存の音声プレビュー全般に追加。単一ファイルの解析は常に同期（キューなし・ポーリングなし）
2. **同期マルチトラック再生** — 同一 tar / ディレクトリ内のマルチチャンネル録音（チャンネル別 wav など）を、スタート時間を揃えて同時再生できる画面下部ドックのプレイヤー。トラック数に上限は設けない
3. **データセットスキャン** — ディレクトリ / tar 単位の一括操作だけをジョブキューに入れる（同時実行 1）。中の音声を順に解析してキャッシュを温めつつ、総時間・発話数・duration 分布・語彙統計を集計して表示する

> 注: 3. データセットスキャンは 2026-07-07 に削除された（単体ファイル解析と同期プレイヤーは現存）。

前提となるデータ・利用状況:

- 音声データセットは WebDataset 式 tar（.wav + .txt/.json ペア）が中心。規模はまちまち
- プレビュー対象は短い発話が主だが、数十分〜数時間の長尺録音も開く
- 長尺対応のため **サーバー側 ffmpeg でストリーミング解析、フロントは描画のみ** という方針（クライアント側 `decodeAudioData` はフルデコードが必要でメモリ的に不可）

## 目的

- 音声ファイル（単体 / tar 内エントリ）のプレビューに波形とスペクトログラムを表示する
- 波形クリックでシークでき、再生ヘッドが追従する
- 長さ・フォーマットによらず一定メモリで解析できる（ストリーミング）
- 単一ファイルの解析は 1 リクエストで完結する（ポーリングなし）。解析待ちが再生をブロックしない
- マルチチャンネル録音のチャンネル別ファイルを頭出しを揃えて同時再生・ミュート/ソロで聴き比べできる
- データセット（ディレクトリ / tar）の全体像（総時間・発話数・分布・語彙）を一目で把握できる

## アーキテクチャ

```
── 単一ファイル (同期・キューなし) ─────────────────────────────
Browser ──① analyze──► api-internal
                         │ キャッシュ命中 → 200 即返し
                         │ 未計算 → media-worker 内部 HTTP に proxy
                         ▼
                   media-worker ── S3 → stream → ffmpeg → 解析
                         │   (同時 MEDIA_CONCURRENCY まで、溢れは順番待ち)
                         ▼
                   media_cache に UPSERT ──► 200 で返却
Browser ◄─ スピナー表示のみ。長尺はレスポンスまで数十秒かかることもある (LAN 前提で許容)

── ディレクトリ / tar 単位 (キュー・同時実行 1) ────────────────
Browser ──② POST scan──► api-internal ── media_jobs に INSERT → 202
                              ▼
                        media_jobs テーブル (FIFO / SKIP LOCKED / 対象 prefix ごとに UNIQUE)
                              ▼
                        media-worker ジョブループ (1 件ずつ)
                              │ prefix 配下 (tar の中身含む) の音声を列挙
                              │ 順に解析 → media_cache を温める
                              │ duration・テキストを集計
                              ▼
                        dataset_stats に結果 UPSERT
Browser ◄─③ スキャン中のみ 1 秒ポーリング (進捗 n/total) → 完了で統計表示
```

### 設計判断

- **単一ファイルは常に同期**。サイズでの分岐はしない。短い発話（大半のケース）は一瞬で返り、長尺もリクエストを保持したまま返す。ブラウザがリクエストを中断（プレビューを閉じる等）したら ffmpeg を kill する
- **ffmpeg は api イメージに入れない**。media-worker に隔離し、api → worker は compose ネットワーク内のみの内部 HTTP（ホスト非公開）で proxy。CPU 負荷も分離される
- **キューはディレクトリ単位の操作専用**。ジョブキューは Postgres（`FOR UPDATE SKIP LOCKED`）。Redis 案と比較したが、新しいステートフルサービスを増やさない・ジョブが再起動を跨いで残る・結果キャッシュ (bytea) も同居できる点で Postgres を採用。追加コンテナは media-worker のみ
- **スキャンの同時実行 1** は worker が `LIMIT 1` でしかジョブを取らないことで担保（研究室 LAN の共有インスタンスで解析が資源を食い潰さないため）
- **ストリーミング**: S3 GetObject（tar エントリは既存 `tar-range` で部分読み）→ ffmpeg stdin。フルダウンロード・フルデコード不要でメモリ一定
- **キャッシュキーに ETag を含める** ため、S3 側でファイルが再アップロードされると自然に再解析される。統計は ETag 追跡まではせず、手動の再スキャンで更新する

## データモデル

マイグレーションでテーブルを 3 つ追加する。

```sql
-- 単一ファイル解析の結果キャッシュ
media_cache (
  cache_key    text PRIMARY KEY,       -- connId:bucket:key(:entryPath):etag
                                       -- tar 内エントリの場合: key = tar のキー, entryPath = tar 内パス
  peaks        jsonb NOT NULL,         -- [[min,max], ...] 固定 2000 バケット・数 KB
  spectrogram  bytea,                  -- PNG。幅は上限 4096px・高さ 256px
  duration_sec real,
  sample_rate  int,
  created_at   timestamptz NOT NULL DEFAULT now()
)

-- ディレクトリ / tar スキャンのジョブキュー
media_jobs (
  id           bigserial PRIMARY KEY,
  target_key   text NOT NULL,          -- connId:bucket:prefix (または tar キー)
                                       -- 部分ユニーク: CREATE UNIQUE INDEX ... ON media_jobs(target_key)
                                       --   WHERE status IN ('queued','processing')
                                       -- → 実行中の多重投入は合流しつつ、完了後の再スキャンは投入できる
  payload      jsonb NOT NULL,         -- {connId, bucket, prefix | tarKey}
  status       text NOT NULL,          -- queued | processing | done | error | canceled
  progress     jsonb,                  -- {filesDone, filesTotal, currentKey}
  error        text,
  created_at / started_at / finished_at timestamptz
)

-- データセット統計 (スキャン結果の永続化)
dataset_stats (
  target_key   text PRIMARY KEY,       -- media_jobs.target_key と同一形式
  result       jsonb NOT NULL,         -- 下記「統計の内容」
  scanned_at   timestamptz NOT NULL
)
```

- 古いキャッシュ / 完了ジョブは worker が定期削除（キャッシュ: 30 日、ジョブ行: 7 日。`dataset_stats` は残す）
- PG ロールは既存方針に従い、api / worker とも `dashboard_rw` を使用

### 統計の内容 (`dataset_stats.result`)

```jsonc
{
  "fileCount": 12034,            // 音声ファイル数 (tar 内含む)
  "totalDurationSec": 43210.5,
  "durationHistogram": [...],    // 固定バケット: 0-1s, 1-2, 2-4, 4-8, 8-15, 15-30, 30-60, 60s+
  "sampleRates": {"16000": 12000, "44100": 34},
  "textFileCount": 12030,        // .txt / .json サイドカーの数
  "vocabSize": 48211,            // 空白区切りトークンの異なり数 (上限 100k で打ち切り、truncated フラグ)
  "charSet": 3021,               // 文字の異なり数
  "topWords": [["の", 9821], ...] // 上位 50
}
```

- テキストは WebDataset のペアリング規則（拡張子違いの同名ファイル）で対応付ける。`.json` は `text` フィールドを見る
- 語彙は空白区切りの素朴なトークン化。分かち書きされていない日本語では語彙統計は参考値になる（文字統計は有効）— 制約として明記

## API

`api/routes/storage-media.ts` を新設（`storage-preview.ts` の隣）。

### `GET /storage/:connId/media/analyze?bucket&key(&entryPath)` — 同期

- HeadObject で ETag を取得し cache_key を構成
- `media_cache` 命中 → 即 `200 {peaks, durationSec, sampleRate, spectrogramUrl}`
- 未計算 → media-worker の内部 HTTP に proxy。worker がその場で解析し `media_cache` に保存 → 同じ形の `200` を返す
- 解析失敗（非音声など）→ `422 {message}`
- worker のスロットが埋まっている間はリクエストが順番待ちで保持される（202 は返さない）

### `GET /storage/:connId/media/spectrogram?cacheKey`

- `media_cache.spectrogram` の PNG をそのまま返す（`<img src>` 用）。キーに ETag 込みのため `Cache-Control: immutable` 相当を付与

### `POST /storage/:connId/media/scan` — キュー投入

- body: `{bucket, prefix}` または `{bucket, tarKey}`
- `INSERT ... ON CONFLICT DO NOTHING`（部分ユニークインデックス対象）→ `202 {jobId}`（既に queued / processing なら既存ジョブの id を返す。done / error 後の再スキャンは新規ジョブになる）
- write 系なので既存方針どおり Origin/Referer チェックの対象

### `GET /storage/:connId/media/scan-status?bucket&prefix`

- 対象の最新ジョブ（あれば）と `dataset_stats`（あれば）を返す: `{job: {status, progress} | null, stats: {...} | null}`
- フロントはスキャン実行中のみ 1 秒ポーリング

### `POST /storage/:connId/media/scan-cancel`

- body: `{jobId}`。status を `canceled` に更新。worker はファイル境界ごとに status を確認して中断する（TB 級データセットの誤スキャン対策）

## media-worker

`api/` と同じ TypeScript コードベースに `worker.ts` を追加し、compose で別サービスとして起動する（dev: `tsx watch worker.ts` / prod: `node dist/worker.js`）。Dockerfile は api と共通ベースに ffmpeg を追加した worker 用ステージを作る。

1 プロセスの中に 2 つの入り口を持つ:

- **内部 HTTP（同期解析）**: compose ネットワーク内のみで listen。同時実行は `MEDIA_CONCURRENCY`（既定 3）まで、超過は in-process FIFO で順番待ち。クライアント切断で ffmpeg を kill
- **ジョブループ（スキャン）**: `SELECT ... WHERE status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`（なければ 1 秒待って再試行）

スキャン処理:

1. prefix 配下を ListObjects で列挙（tar はエントリ一覧を読み、WebDataset ペアリング）。`MEDIA_SCAN_MAX_FILES`（既定 100k）超過は打ち切り + 統計に truncated フラグ
2. 音声を 1 ファイルずつ解析（同期解析と同じ関数を使い、`media_cache` に UPSERT）。既にキャッシュ済み (ETag 一致) のファイルはスキップ
3. duration・サンプルレート・テキスト統計をインクリメンタルに集計（vocab は上限 100k で打ち切り）
4. ファイル境界ごとに `progress` を更新し、`canceled` を確認
5. 完了で `dataset_stats` に UPSERT → ジョブ `done`

単一ファイル解析（同期・スキャン共通の関数）:

- ffmpeg 2 パス（stdout は 1 本しかないため、パスごとに S3 から再ストリーミング。追加メモリなし・GetObject が 2 回になるだけ）:
  - ピーク: `ffmpeg -i pipe:0 -ac 1 -f f32le pipe:1` の出力を読みながら固定 2000 バケットで min/max 集計（メモリ一定）。総サンプル数から duration_sec も算出
  - スペクトログラム: `ffmpeg -i pipe:0 -lavfi showspectrumpic=s=Wx256 pipe:1` で PNG 生成（高さ 256px 固定）。W は duration に比例させつつ上限 4096px
- ガード: 1 ファイルあたりタイムアウト `MEDIA_ANALYZE_TIMEOUT_SEC`（既定 300）で kill。ffmpeg 異常終了は stderr 要約をエラーとして返す（スキャン中は該当ファイルをスキップして続行）
- worker プロセス異常終了で `processing` のまま残ったジョブは、起動時に `queued` へ戻す

## フロントエンド

### 波形 / スペクトログラム（PreviewAudio の拡張）

props インターフェース（`connId, bucket, k`）は維持し、tar エントリ用に optional な `entryPath` を追加（その場合 `k` は tar のキー）。呼び出し側 (PreviewDrawer / TarEntryModal) の変更は最小。

```
┌──────────────────────────────────┐
│ ▶ 0:04 / 0:12        (既存 <audio>)│
├──────────────────────────────────┤
│  ██▅▂▃▇█▆▃▁▂▅██▇▅▃  波形 canvas    │ ← クリックでシーク / 再生ヘッド追従
├──────────────────────────────────┤
│  ▓▓▒▒░░▒▓▓▒░▒▒▓▓  スペクトログラム │ ← <img> (トグル表示)
└──────────────────────────────────┘
```

- **再生は従来通り即可能**: `<audio>` は既存のストリーミング URL のまま。波形/スペクトログラムは analyze が返り次第、下に「生えてくる」
- **通信は 1 リクエスト**: マウント時に `analyze` を呼び、返るまで小さなスピナー表示。アンマウントで AbortController により中断（→ サーバー側で ffmpeg kill）。失敗は小さくメッセージ表示
- **波形描画**: ピーク JSON を devicePixelRatio 対応 canvas に描画。色は Tailwind テーマトークンからとりダークモード追従
- **シーク**: canvas クリック位置の比率 × duration → `audio.currentTime`。再生ヘッドは `requestAnimationFrame` で描画
- **スペクトログラム**: サーバー生成 PNG を `<img>` 表示。デフォルトは波形のみ、スペクトログラムはトグル（縦スペース節約）
- ズーム機能は v1 では作らない (YAGNI)

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

### データセット統計パネル

- ディレクトリビュー / tar プレビューのヘッダに「スキャン」アクションを追加
- `scan-status` に応じて表示: 未スキャン →「スキャンを実行」ボタンのみ / 実行中 → 進捗バー (n/total) + キャンセル / 完了 → 統計パネル + 再スキャンボタン
- 統計パネル: 総時間・ファイル数・平均 duration などのサマリ数値 + duration 分布の簡易バーチャート（Tailwind ベース、チャートライブラリは入れない）+ 語彙サイズ・文字種数・頻出語
- スキャン実行中のみ 1 秒ポーリング。パネルを閉じてもスキャンは進む（サーバー側ジョブなので）

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| 非音声ファイルを解析 | ffmpeg 失敗 → 422 → 小さくエラー表示。既存の再生 UI には影響なし |
| 解析タイムアウト (5 分/ファイル) | 単体: 422 表示 / スキャン中: そのファイルをスキップして続行 |
| プレビューを閉じる | リクエスト中断 → worker が ffmpeg を kill |
| worker 停止中 | 単体 analyze: proxy 失敗 → エラー表示 / スキャン: queued のまま、worker 復帰後に消化 |
| 巨大 prefix の誤スキャン | 進捗表示 + キャンセルボタン。`MEDIA_SCAN_MAX_FILES` で上限 |
| S3 側でファイル更新 | ETag が変わり cache_key が変わるため自然に再解析。統計は手動再スキャン |
| 解析済み再訪問 | キャッシュ命中で即描画 |

## テスト

既存の流儀（vitest、`api/lib/test-fixtures`）に従う。

- **API**: analyze のキャッシュ命中 / proxy 経路 / 失敗時 422、scan の投入と合流 (ON CONFLICT)、scan-status の形、cancel、spectrogram 配信、POST 系の Origin チェック
- **worker**: ピークのバケット化・統計集計（histogram / vocab 打ち切り）を純関数として単体テスト。ffmpeg 本体は fixture の小さい wav / WebDataset 風 tar で統合テスト（CI に ffmpeg が要る点は worker コンテナ内でのテスト実行で回避可）。同期スロットの順番待ち、スキャンのキャンセル・スキップ継続
- **フロント**: analyze をモックしスピナー→波形描画・エラー表示・クリックシークを確認。デッキはトラック追加/削除・ミュート/ソロ・マスター再生で全 `<audio>` の play が呼ばれること・ドリフト補正ロジック（純関数化してテスト）。統計パネルは status ごとの表示切り替え

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `MEDIA_CONCURRENCY` | 3 | worker の同期解析の同時実行数（超過は順番待ち） |
| `MEDIA_ANALYZE_TIMEOUT_SEC` | 300 | 1 ファイルの解析タイムアウト |
| `MEDIA_SCAN_MAX_FILES` | 100000 | 1 スキャンで処理するファイル数上限 |
| `MEDIA_CACHE_MAX_AGE_DAYS` | 30 | media_cache の保持日数 |
| `MEDIA_SPECTROGRAM_MAX_WIDTH` | 4096 | スペクトログラム PNG の最大幅 (px) |

## 将来拡張

本設計のパイプライン（同期解析 + スキャンキュー + media_cache / dataset_stats）を土台に、SDE の残りの機能を段階的に足せる:

1. **発話ブラウズ**: tar プレビューで .wav + .txt/.json をペア化した「発話ビュー」（テキスト列 + 再生ボタン + 波形サムネイル）。スキャン済みなら波形は即表示
2. **ASR 誤り分析**: manifest / サイドカーに pred_text があれば WER/CER + diff ハイライト
3. **連続再生（流し聴き）**: 一覧を上から順に自動で再生し続けるモード。デッキのトランスポートを流用できる
4. **語彙統計の高度化**: 日本語の分かち書き（形態素解析）を worker に足す

## ロールバック

- フロント: PreviewAudio の波形部分は追加 UI のみなので、コンポーネントから解析ブロックを外せば従来表示に戻る。デッキ・統計パネルは独立コンポーネント + Context なので丸ごと外せる
- バックエンド: media-worker サービスと routes を外し、テーブル 3 つを drop
