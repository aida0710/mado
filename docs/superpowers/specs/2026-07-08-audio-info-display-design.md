# 音声プレビューの詳細情報表示

## 背景

音声プレビューには波形とスペクトログラム（トグル）があるが、ファイルのフォーマット情報が何も見えない。データセットを扱う上で「コーデック・チャンネル数・サンプルレート・ビット深度・音量」はファイルを開いたときに即座に知りたい情報。解析パイプライン（media-worker の ffprobe + ffmpeg ピークパス）は既に走っているので、その副産物として安価に取れる。

## 目的

- 音声プレビュー（単体 / tar 内エントリ）に、フォーマット基本情報・長さ/サイズ・音量（peak/RMS）を常時表示する
- スペクトログラムはトグルをやめて常時表示にする（生成済み・キャッシュ済みなので表示コストは PNG 転送のみ）
- 追加の ffmpeg/ffprobe パスは増やさない（既存パスの拡張・副産物のみ）

## 設計

### worker 側（解析の拡張）

- **ffprobe 拡張**（`media-analyze.ts` の probeSampleRate → probeMetadata に改名・拡張）:
  `-show_entries stream=codec_name,channels,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate -show_entries format=format_name,bit_rate` を JSON で取得。取れない項目は null
- **peak dBFS / RMS dB**（ピークパスの副産物）: f32le サンプル走査時に `max|sample|` と `Σsample²` を追加集計（PeakAccumulator 拡張 or 並走の小さなアキュムレータ）。
  peak = 20·log10(max|s|)、RMS = 20·log10(√(Σs²/N))。無音（max=0）は両方 null。
  検証基準: フルスケールサイン波 → peak ≈ 0 dBFS / RMS ≈ −3.01 dB
- **sizeBytes**: 単体ファイルは GetObject の ContentLength、tar エントリは抽出済み buffer 長。worker が把握しているので meta に含めて保存
- **bitRate の決定順**: stream の bit_rate → format の bit_rate → 計算値（sizeBytes×8/durationSec）。どれも無ければ null

### データモデル

- マイグレーション `009_media_meta.sql`: `ALTER TABLE media_cache ADD COLUMN IF NOT EXISTS meta jsonb`
- meta の形:
  ```jsonc
  {
    "codec": "flac",          // codec_name
    "container": "flac",      // format_name
    "channels": 2,
    "bitsPerSample": 24,       // bits_per_raw_sample ?? bits_per_sample、無ければ null (mp3 等)
    "bitRate": 1411000,        // bps
    "sizeBytes": 2097152,
    "peakDb": -0.3,            // dBFS
    "rmsDb": -18.2
  }
  ```
- **既存キャッシュ行のバックフィル**: `meta IS NULL` の行はキャッシュミス扱いで再解析（getCachedMedia → analyzeAndCache の判定に `meta IS NOT NULL` を追加）。キー変更なし・自然に埋まる

### API

- `GET /media/analyze` のレスポンスに `meta`（上記オブジェクト、null 許容）を追加。エンドポイント追加なし

### フロント（PreviewAudio）

- スペクトログラム: トグル撤去、`hasSpectrogram` なら波形の直下に常時 `<img>` 表示
- その下に情報行（mono の既存情報行と同じトーン、値が null の項目は詰めて省略）:
  ```
  FLAC · stereo · 48 kHz · 24 bit
  1411 kbps · 0:12.345 · 2.1 MB
  peak -0.3 dBFS · RMS -18.2 dB
  ```
  - channels: 1→mono / 2→stereo / N→`N ch`
  - 長さ: durationSec を `m:ss.mmm`（1 時間超は `h:mm:ss`）
  - サイズ: 既存 `fmtSize`（front/lib/format.ts）を再利用
- デッキには表示しない（プレビューのみ）
- zod: `MediaAnalyze` に `meta` オブジェクト（nullable フィールド群）を追加

## エラーハンドリング

| ケース | 挙動 |
|---|---|
| ffprobe で一部項目が取れない (mp3 の bit 深度等) | その項目だけ null → UI で省略 |
| 無音ファイル | peakDb/rmsDb null → 音量行を省略 |
| 旧キャッシュ行 (meta なし) | キャッシュミス扱いで再解析（透過的にバックフィル） |
| meta 全体が null (旧 API との互換) | 情報行を出さない (波形/スペクトログラムは従来通り) |

## テスト

- **worker**: probeMetadata のパース（実 ffmpeg 統合、fixture wav: pcm_s16le/mono/16000Hz/16bit を assert）/ peak/RMS の純ロジック（フルスケールサイン波 → 0 / −3.01 dB、無音 → null）/ meta IS NULL 行の再解析
- **API**: analyze レスポンスに meta が乗る
- **フロント**: 情報行のフォーマット（null 省略・channels 表記・時間表記）を純関数として単体テスト + 表示テスト。スペクトログラム常時表示（トグル消滅）

## ロールバック

- フロント: 情報行と常時表示を戻すだけ
- DB: meta カラム drop（波形キャッシュは無傷）
