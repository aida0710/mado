# 音声詳細情報表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 音声プレビューにフォーマット情報・サイズ・音量（peak/RMS）を常時表示し、スペクトログラムも常時表示化する。

**Architecture:** worker の既存 ffprobe を拡張（codec/channels/bit depth/bit rate/container）、ピークパスの副産物で peak dBFS/RMS を集計、`media_cache.meta` jsonb（migration 009）に保存。`meta IS NULL` はキャッシュミス扱いで自然バックフィル。フロントは PreviewAudio に情報行を追加しスペクトログラムのトグルを撤去。

**Spec:** `docs/superpowers/specs/2026-07-08-audio-info-display-design.md`

## Global Constraints

- ブランチ: feature/audio-explorer。コミットは feat:/fix: + 日本語、amend なし
- git stash 禁止
- api DB テスト env（同一シェルで）: `RWURL=$(grep '^DATABASE_URL_RW=' /Users/aida/PhpstormProjects/web-dashboard/.env | cut -d= -f2-); PW=$(echo "$RWURL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|'); export DATABASE_URL_RW_TEST="postgres://dashboard_rw:${PW}@localhost:5432/dashboard_test"`
- front lint は main 由来の既存 4 エラーが baseline（新規なし）
- meta の形は spec の jsonc 定義が正（codec/container/channels/bitsPerSample/bitRate/sizeBytes/peakDb/rmsDb、全 nullable）
- peak = 20·log10(max|s|) / RMS = 20·log10(√(Σs²/N))、無音は両方 null。検証: フルスケールサイン波 → peak ≈ 0 / RMS ≈ −3.01 (±0.1)
- bitRate 決定順: stream → format → sizeBytes×8/durationSec → null
- 追加の ffmpeg/ffprobe プロセスを増やさない（既存 2 パス + probe の拡張のみ）

---

### Task 1: worker/API — meta 解析と保存

**Files:**
- Create: `db/migrations/009_media_meta.sql`
- Modify: `api/lib/media-analyze.ts`, `api/lib/media-peaks.ts`（or 並走アキュムレータ）, `api/lib/media-cache.ts`, `api/lib/media-service.ts`, `api/routes/storage-media.ts`（レスポンスに meta）
- Test: 既存の対応するテストファイルに追記

**Interfaces（Task 2 が依存）:**
- analyze レスポンス: `{cacheKey, peaks, durationSec, sampleRate, hasSpectrogram, meta: {codec, container, channels, bitsPerSample, bitRate, sizeBytes, peakDb, rmsDb} | null}`（meta の各フィールドは null 許容）

**Steps（TDD で順に）:**

- [ ] 009_media_meta.sql: `ALTER TABLE media_cache ADD COLUMN IF NOT EXISTS meta jsonb;`（コメント付き、dev/test 両 DB に適用）
- [ ] peak/RMS 集計: ピークパスの f32le 走査で max|s| と Σs² を集計する純ロジック + 単体テスト（フルスケールサイン波 0/−3.01、無音 null）。PeakAccumulator 拡張か LoudnessAccumulator 新設かは既存コードを見て自然な方
- [ ] probeMetadata: ffprobe の -show_entries を拡張し JSON パース（stream: codec_name/channels/sample_rate/bits_per_raw_sample/bits_per_sample/bit_rate、format: format_name/bit_rate）。実 ffmpeg 統合テストで fixture wav (pcm_s16le/mono/16000) を assert
- [ ] AnalyzeResult に meta 相当フィールドを追加し、analyzeAudio が組み立てる（sizeBytes は呼び出し側から渡す — 単体: GetObject ContentLength を openStream 作成時に捕捉 / tar: extracted.buffer.length）。bitRate fallback 計算
- [ ] media-cache: upsert で meta 保存、getCachedMedia が meta を返す + **`meta IS NOT NULL` をキャッシュ命中条件に追加**（旧行の自然バックフィル）。round-trip テスト
- [ ] storage-media.ts: analyze レスポンスに meta（キャッシュ命中/proxy 両経路）。テスト更新
- [ ] 検証: api `npm test`/`tsc`/`lint` green → `docker compose -f compose.dev.yaml restart media-worker api-internal` 後、MinIO の recordings/ch1.wav で `curl .../media/analyze` に meta が乗ること（旧キャッシュ行のバックフィルも実証: 既存 cacheKey が meta 付きで返る）
- [ ] コミット: `feat: 音声解析に詳細メタ情報 (コーデック/音量/サイズ) を追加`

### Task 2: フロント — 情報行 + スペクトログラム常時表示

**Files:**
- Create: `front/lib/audioInfo.ts`（フォーマット純関数）+ test
- Modify: `front/lib/api/types.ts`（MediaAnalyze に meta）, `front/components/PreviewAudio.tsx`
- Test: `front/lib/audioInfo.test.ts`, `front/components/PreviewAudio.test.tsx` 更新

**Steps:**

- [ ] zod: MediaAnalyze に `meta: z.object({codec: z.string().nullable(), container: z.string().nullable(), channels: z.number().nullable(), bitsPerSample: z.number().nullable(), bitRate: z.number().nullable(), sizeBytes: z.number().nullable(), peakDb: z.number().nullable(), rmsDb: z.number().nullable()}).nullable()`
- [ ] audioInfo.ts 純関数: `formatAudioInfoLines(meta, durationSec, sampleRate): string[]`（最大 3 行、null 項目は省略、行が空なら行ごと省略）。表記: channels 1→mono/2→stereo/N→`N ch`、`48 kHz`、`24 bit`、`1411 kbps`（bitRate/1000 四捨五入）、時間 `m:ss.mmm`（≥1h は `h:mm:ss`）、サイズは既存 fmtSize 再利用、`peak -0.3 dBFS · RMS -18.2 dB`（小数 1 桁）。単体テストで null 省略・境界（1h・無音）を検証
- [ ] PreviewAudio: スペクトログラムのトグル撤去（hasSpectrogram なら常時 `<img>`）、その下に情報行（`font-mono text-[11px] text-ink-7` 系の既存トーン、各行 `<p>`）。meta が null なら情報行なし。既存テスト更新（トグルの assert を常時表示 assert に差し替え）+ 情報行の表示テスト
- [ ] 検証: front `npm test`/`tsc -b`/`lint`（baseline 4 のみ）→ ブラウザで ch1.wav のプレビューに情報行が出ること
- [ ] コミット: `feat: 音声プレビューに詳細情報を常時表示`
