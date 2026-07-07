# 音声波形/スペクトログラム + 同期デッキ + データセットスキャン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 音声プレビューに波形/スペクトログラム表示を追加し、マルチチャンネル音声の同期再生デッキと、ディレクトリ/tar 単位のデータセットスキャン（統計 + キャッシュ温め）を実装する。

**Architecture:** ffmpeg を持つ `media-worker` コンテナが解析を担う。単一ファイル解析は api → worker の内部 HTTP proxy で完全同期（キューなし）。ディレクトリ/tar スキャンのみ Postgres の `FOR UPDATE SKIP LOCKED` キュー（同時実行 1）。結果は `media_cache` / `dataset_stats` テーブルに保存。フロントは描画のみ（canvas 波形 + `<img>` スペクトログラム + `<audio>` ベースの同期デッキ）。

**Tech Stack:** Hono / pg / ffmpeg (spawn) / React 19 / zod / vitest

**Spec:** `docs/superpowers/specs/2026-07-07-audio-waveform-spectrogram-design.md`

## Global Constraints

- 環境変数と既定値: `MEDIA_CONCURRENCY=3`, `MEDIA_ANALYZE_TIMEOUT_SEC=300`, `MEDIA_SCAN_MAX_FILES=100000`, `MEDIA_CACHE_MAX_AGE_DAYS=30`, `MEDIA_SPECTROGRAM_MAX_WIDTH=4096`, `MEDIA_WORKER_PORT=3100`, `MEDIA_WORKER_URL=http://media-worker:3100`
- 波形ピークは固定 2000 バケットの `[[min,max],...]`。スペクトログラム PNG は高さ 256px、幅は duration × 50px/s を 640〜4096px にクランプ
- ピークパスの ffmpeg 出力は `-ac 1 -ar 16000 -f f32le` 固定。duration = 総サンプル数 / 16000
- cache_key = sha256(JSON.stringify([connId, bucket, key, entryPath ?? '', etag])) の hex
- tar 内エントリの参照は `key` = tar のキー + `entryPath` = tar 内パス
- API テストの DB は favorites テストと同じ `DATABASE_URL_RW_TEST`（既定 `postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test`）
- コミットメッセージは既存流儀（`feat:` / `fix:` / `docs:` + 日本語）
- api / front とも `npm test` `npm run lint` が通ること。テスト実行前に `docker compose -f compose.dev.yaml up -d postgres`
- lint 設定は strict。未使用 import を残さない。既存ファイルのスタイル（2 スペース、セミコロンなし規約は既存コード準拠）に従う

## 実行前の準備

- [ ] `docker compose -f compose.dev.yaml up -d postgres` で Postgres を起動しておく
- [ ] `cd api && npm install` / `cd front && npm install` 済みであること
- [ ] ホストに ffmpeg があるか確認: `ffmpeg -version`（Task 5 の統合テストに必要。無ければ `brew install ffmpeg`）

---

### Task 1: DB マイグレーション (media_cache / media_jobs / dataset_stats)

**Files:**
- Create: `db/migrations/006_media.sql`

**Interfaces:**
- Produces: テーブル `media_cache(cache_key text PK, peaks jsonb, spectrogram bytea, duration_sec real, sample_rate int, created_at)`, `media_jobs(id serial PK, target_key text, payload jsonb, status text, progress jsonb, error text, created_at, started_at, finished_at)` + 部分ユニークインデックス, `dataset_stats(target_key text PK, result jsonb, scanned_at)`

- [ ] **Step 1: マイグレーション SQL を書く**

`db/migrations/006_media.sql`:

```sql
-- 音声解析キャッシュ + データセットスキャン (spec: 2026-07-07-audio-waveform-spectrogram-design.md)

-- 単一ファイル解析の結果キャッシュ。
-- cache_key は sha256(JSON([connId, bucket, key, entryPath, etag])) の hex。
-- ETag をキーに含めるため、S3 側の再アップロードで自然に無効化される。
CREATE TABLE IF NOT EXISTS media_cache (
  cache_key    TEXT PRIMARY KEY,
  peaks        JSONB NOT NULL,          -- [[min,max], ...] 固定 2000 バケット
  spectrogram  BYTEA,                   -- PNG (幅 <= 4096px, 高さ 256px)
  duration_sec REAL,
  sample_rate  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ディレクトリ / tar スキャンのジョブキュー。単一ファイル解析はキューを通らない。
CREATE TABLE IF NOT EXISTS media_jobs (
  -- SERIAL (int4): pg ドライバは int8 を string で返すため、フロントの
  -- z.number() と揃えて int4 にする (ジョブ数は小さい)。
  id          SERIAL PRIMARY KEY,
  target_key  TEXT NOT NULL,            -- connId \n bucket \n (prefix | tarKey)
  payload     JSONB NOT NULL,           -- {connId, bucket, prefix?, tarKey?}
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','processing','done','error','canceled')),
  progress    JSONB,                    -- {filesDone, filesTotal, currentKey}
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- 実行中 (queued/processing) の同一ターゲットは 1 件に合流させる。
-- done/error/canceled の行が残っていても再スキャンは投入できる。
CREATE UNIQUE INDEX IF NOT EXISTS media_jobs_active_target
  ON media_jobs (target_key)
  WHERE status IN ('queued', 'processing');

-- スキャン結果 (統計) の永続化。再スキャンで UPSERT。
CREATE TABLE IF NOT EXISTS dataset_stats (
  target_key TEXT PRIMARY KEY,          -- media_jobs.target_key と同一形式
  result     JSONB NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL
);
```

- [ ] **Step 2: dev DB と test DB に適用する**

```bash
docker compose -f compose.dev.yaml exec postgres \
  psql -U dashboard_rw -d dashboard -f /migrations/006_media.sql
docker compose -f compose.dev.yaml exec postgres \
  psql -U dashboard_rw -d dashboard_test -f /migrations/006_media.sql
```

Expected: それぞれ `CREATE TABLE` × 3 / `CREATE INDEX` が出力される（エラーなし）

- [ ] **Step 3: 適用を確認する**

```bash
docker compose -f compose.dev.yaml exec postgres \
  psql -U dashboard_ro -d dashboard -c "SELECT count(*) FROM media_cache; SELECT count(*) FROM media_jobs; SELECT count(*) FROM dataset_stats;"
```

Expected: 3 つとも `0`（ro ロールで SELECT できること = 権限伝播も確認）

- [ ] **Step 4: Commit**

```bash
git add db/migrations/006_media.sql
git commit -m "feat: media 解析キャッシュ / スキャンキュー / 統計テーブルのマイグレーションを追加"
```

---

### Task 2: env.ts に MEDIA_* 環境変数を追加

**Files:**
- Modify: `api/env.ts`
- Test: `api/env.test.ts`（既存に追記）

**Interfaces:**
- Produces: `Env` 型に `MEDIA_CONCURRENCY: number`, `MEDIA_ANALYZE_TIMEOUT_SEC: number`, `MEDIA_SCAN_MAX_FILES: number`, `MEDIA_CACHE_MAX_AGE_DAYS: number`, `MEDIA_SPECTROGRAM_MAX_WIDTH: number`, `MEDIA_WORKER_PORT: number`, `MEDIA_WORKER_URL: string` が加わる（全て default 付き = 既存 .env を壊さない）

- [ ] **Step 1: 失敗するテストを書く**

`api/env.test.ts` の既存 describe 内に追記:

```ts
it('MEDIA_* は default 値で読める', () => {
  const env = loadEnv({
    DATABASE_URL_RW: 'postgres://x',
    DATABASE_URL_RO: 'postgres://x',
    ENCRYPTION_KEY: '0'.repeat(64),
    ALLOWED_ORIGINS: 'http://localhost:5173',
  })
  expect(env.MEDIA_CONCURRENCY).toBe(3)
  expect(env.MEDIA_ANALYZE_TIMEOUT_SEC).toBe(300)
  expect(env.MEDIA_SCAN_MAX_FILES).toBe(100000)
  expect(env.MEDIA_CACHE_MAX_AGE_DAYS).toBe(30)
  expect(env.MEDIA_SPECTROGRAM_MAX_WIDTH).toBe(4096)
  expect(env.MEDIA_WORKER_PORT).toBe(3100)
  expect(env.MEDIA_WORKER_URL).toBe('http://media-worker:3100')
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run env.test.ts`
Expected: FAIL（`MEDIA_CONCURRENCY` が undefined）

- [ ] **Step 3: env.ts に追記**

`api/env.ts` の schema オブジェクト末尾（`PREVIEW_TARXZ_BYTE_LIMIT` の次）に:

```ts
  // media-worker (波形/スペクトログラム解析) 関連。全て default 付きで
  // 既存デプロイの .env を変更せずに済む。
  MEDIA_CONCURRENCY: z.coerce.number().default(3),
  MEDIA_ANALYZE_TIMEOUT_SEC: z.coerce.number().default(300),
  MEDIA_SCAN_MAX_FILES: z.coerce.number().default(100000),
  MEDIA_CACHE_MAX_AGE_DAYS: z.coerce.number().default(30),
  MEDIA_SPECTROGRAM_MAX_WIDTH: z.coerce.number().default(4096),
  MEDIA_WORKER_PORT: z.coerce.number().default(3100),
  MEDIA_WORKER_URL: z.string().default('http://media-worker:3100'),
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run env.test.ts`
Expected: PASS（既存ケース含む）

- [ ] **Step 5: Commit**

```bash
git add api/env.ts api/env.test.ts
git commit -m "feat: MEDIA_* 環境変数を追加"
```

---

### Task 3: ピーク集計の純ロジック (PeakAccumulator)

**Files:**
- Create: `api/lib/media-peaks.ts`
- Test: `api/lib/media-peaks.test.ts`

**Interfaces:**
- Produces:
  - `class PeakAccumulator { push(samples: Float32Array): void; finish(bucketCount?: number): { peaks: Array<[number, number]>; totalSamples: number } }`
  - `export const PEAK_BUCKETS = 2000`
- ストリーミング前提: 総サンプル数を事前に知らずに一定メモリで動く。内部は「窓ごとの min/max ペア列」を持ち、ペア数が上限を超えたら隣接ペアをマージして窓を倍にする

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/media-peaks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PeakAccumulator, PEAK_BUCKETS } from './media-peaks.js'

describe('PeakAccumulator', () => {
  it('少サンプルでも finish で指定バケット数以下の peaks を返す', () => {
    const acc = new PeakAccumulator()
    acc.push(new Float32Array([0.5, -0.5, 0.25]))
    const { peaks, totalSamples } = acc.finish(4)
    expect(totalSamples).toBe(3)
    expect(peaks.length).toBeLessThanOrEqual(4)
    // 全体の min/max が保存されている
    const min = Math.min(...peaks.map(p => p[0]))
    const max = Math.max(...peaks.map(p => p[1]))
    expect(min).toBeCloseTo(-0.5)
    expect(max).toBeCloseTo(0.5)
  })

  it('大量サンプルでも内部ペア数が上限内に収まり finish は既定 2000 バケット', () => {
    const acc = new PeakAccumulator({ windowSamples: 16, maxPairs: 64 })
    const chunk = new Float32Array(1024).fill(0.1)
    chunk[0] = -1
    chunk[1023] = 1
    for (let i = 0; i < 100; i++) acc.push(chunk)
    const { peaks, totalSamples } = acc.finish()
    expect(totalSamples).toBe(1024 * 100)
    expect(peaks.length).toBeLessThanOrEqual(PEAK_BUCKETS)
    expect(Math.min(...peaks.map(p => p[0]))).toBeCloseTo(-1)
    expect(Math.max(...peaks.map(p => p[1]))).toBeCloseTo(1)
  })

  it('チャンク境界をまたぐ窓が欠落しない (push を細切れにしても同じ結果)', () => {
    const data = new Float32Array(1000).map(() => Math.random() * 2 - 1)
    const a = new PeakAccumulator({ windowSamples: 64 })
    a.push(data)
    const b = new PeakAccumulator({ windowSamples: 64 })
    for (let i = 0; i < data.length; i += 7) b.push(data.subarray(i, Math.min(i + 7, data.length)))
    expect(b.finish(100)).toEqual(a.finish(100))
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run lib/media-peaks.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`api/lib/media-peaks.ts`:

```ts
// ストリーミングで音声サンプル列の min/max ピークを一定メモリで集計する。
// 「窓 (windowSamples) ごとの [min,max] ペア列」を保持し、ペア数が maxPairs を
// 超えたら隣接ペアをマージして窓を倍にする — 総サンプル数を事前に知らなくても
// メモリは maxPairs で頭打ちになる。finish() で任意のバケット数に縮約する。

export const PEAK_BUCKETS = 2000

export interface PeakAccumulatorOpts {
  windowSamples?: number
  maxPairs?: number
}

export class PeakAccumulator {
  private windowSamples: number
  private readonly maxPairs: number
  private pairs: Array<[number, number]> = []
  private curMin = Infinity
  private curMax = -Infinity
  private curCount = 0
  private total = 0

  constructor(opts: PeakAccumulatorOpts = {}) {
    this.windowSamples = opts.windowSamples ?? 1024
    this.maxPairs = opts.maxPairs ?? 100_000
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]
      if (v < this.curMin) this.curMin = v
      if (v > this.curMax) this.curMax = v
      this.curCount++
      this.total++
      if (this.curCount === this.windowSamples) this.flushWindow()
    }
  }

  private flushWindow(): void {
    this.pairs.push([this.curMin, this.curMax])
    this.curMin = Infinity
    this.curMax = -Infinity
    this.curCount = 0
    if (this.pairs.length > this.maxPairs) this.halve()
  }

  // 隣接ペアをマージして解像度を半分にする (窓は倍になる)。
  private halve(): void {
    const merged: Array<[number, number]> = []
    for (let i = 0; i < this.pairs.length; i += 2) {
      const a = this.pairs[i]
      const b = this.pairs[i + 1]
      merged.push(b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : a)
    }
    this.pairs = merged
    this.windowSamples *= 2
  }

  finish(bucketCount = PEAK_BUCKETS): { peaks: Array<[number, number]>; totalSamples: number } {
    if (this.curCount > 0) {
      this.pairs.push([this.curMin, this.curMax])
      this.curMin = Infinity
      this.curMax = -Infinity
      this.curCount = 0
    }
    const src = this.pairs
    if (src.length === 0) return { peaks: [], totalSamples: this.total }
    if (src.length <= bucketCount) {
      return { peaks: src.map(p => [...p] as [number, number]), totalSamples: this.total }
    }
    // src.length 個のペアを bucketCount 個へ等分マージ
    const peaks: Array<[number, number]> = []
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor((b * src.length) / bucketCount)
      const end = Math.max(start + 1, Math.floor(((b + 1) * src.length) / bucketCount))
      let mn = Infinity
      let mx = -Infinity
      for (let i = start; i < end; i++) {
        if (src[i][0] < mn) mn = src[i][0]
        if (src[i][1] > mx) mx = src[i][1]
      }
      peaks.push([mn, mx])
    }
    return { peaks, totalSamples: this.total }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/media-peaks.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add api/lib/media-peaks.ts api/lib/media-peaks.test.ts
git commit -m "feat: 波形ピークのストリーミング集計 (PeakAccumulator) を追加"
```

---

### Task 4: データセット統計の純ロジック (DatasetStatsAccumulator / WebDataset ペアリング)

**Files:**
- Create: `api/lib/media-stats.ts`
- Test: `api/lib/media-stats.test.ts`

**Interfaces:**
- Produces:
  - `export const AUDIO_EXTS: Set<string>`（`front/lib/api/mime.ts` の audio 集合と同じ拡張子: mp3, wav, flac, ogg, oga, opus, m4a, m4b, aac, weba, aiff, aif, wma）
  - `export function isAudioName(name: string): boolean`
  - `export function pairWebdataset(names: string[]): Array<{ audio: string; text: string | null }>` — 音声ごとに同 basename の `.txt` / `.json` を対応付け
  - `export class DatasetStatsAccumulator { addAudio(durationSec: number | null, sampleRate: number | null): void; addText(text: string): void; markTruncated(): void; result(): DatasetStatsResult }`
  - `export interface DatasetStatsResult { fileCount: number; totalDurationSec: number; durationHistogram: Array<{ le: number | null; count: number }>; sampleRates: Record<string, number>; textFileCount: number; vocabSize: number; vocabTruncated: boolean; charSet: number; topWords: Array<[string, number]> }`
- ヒストグラムのバケット境界は `[1, 2, 4, 8, 15, 30, 60]` 秒 + 最後 `le: null`（60s 超）
- 語彙は空白区切りトークン化、上限 100_000 語で打ち切り（`vocabTruncated: true`）。`topWords` は上位 50

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/media-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DatasetStatsAccumulator,
  isAudioName,
  pairWebdataset,
} from './media-stats.js'

describe('pairWebdataset', () => {
  it('同 basename の .txt / .json を音声に対応付ける', () => {
    const pairs = pairWebdataset([
      'utt_0001.wav', 'utt_0001.txt',
      'utt_0002.flac', 'utt_0002.json',
      'utt_0003.wav',
      'notes.md',
    ])
    expect(pairs).toEqual([
      { audio: 'utt_0001.wav', text: 'utt_0001.txt' },
      { audio: 'utt_0002.flac', text: 'utt_0002.json' },
      { audio: 'utt_0003.wav', text: null },
    ])
  })

  it('isAudioName は音声拡張子だけ true', () => {
    expect(isAudioName('a.wav')).toBe(true)
    expect(isAudioName('a.WAV')).toBe(true)
    expect(isAudioName('a.txt')).toBe(false)
    expect(isAudioName('a.tar')).toBe(false)
  })
})

describe('DatasetStatsAccumulator', () => {
  it('duration ヒストグラムと合計を集計する', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addAudio(0.5, 16000)
    acc.addAudio(3.0, 16000)
    acc.addAudio(120, 44100)
    acc.addAudio(null, null) // duration 不明はカウントのみ
    const r = acc.result()
    expect(r.fileCount).toBe(4)
    expect(r.totalDurationSec).toBeCloseTo(123.5)
    const h = Object.fromEntries(r.durationHistogram.map(b => [String(b.le), b.count]))
    expect(h['1']).toBe(1)   // 0.5s
    expect(h['4']).toBe(1)   // 3.0s
    expect(h['null']).toBe(1) // 120s (60s 超)
    expect(r.sampleRates).toEqual({ '16000': 2, '44100': 1 })
  })

  it('テキスト統計: vocab / charSet / topWords', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addText('hello world')
    acc.addText('hello again')
    const r = acc.result()
    expect(r.textFileCount).toBe(2)
    expect(r.vocabSize).toBe(3)
    expect(r.topWords[0]).toEqual(['hello', 2])
    // charSet: h,e,l,o,空白以外の文字…ユニーク文字数 (空白は除外)
    expect(r.charSet).toBe(new Set('helloworldagain').size)
  })

  it('.json サイドカーは text フィールドを読む (呼び出し側で抽出) — addText は素の文字列を受ける', () => {
    const acc = new DatasetStatsAccumulator()
    acc.addText('こんにちは')
    const r = acc.result()
    // 分かち書きなし日本語: 1 トークン扱い、文字は 5 種
    expect(r.vocabSize).toBe(1)
    expect(r.charSet).toBe(5)
  })

  it('vocab 上限で打ち切りフラグが立つ', () => {
    const acc = new DatasetStatsAccumulator({ vocabLimit: 3 })
    acc.addText('a b c d e')
    const r = acc.result()
    expect(r.vocabSize).toBe(3)
    expect(r.vocabTruncated).toBe(true)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run lib/media-stats.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`api/lib/media-stats.ts`:

```ts
// データセットスキャンの統計集計 (純ロジック)。worker のスキャンループから
// インクリメンタルに呼ばれる。語彙は空白区切りの素朴なトークン化なので、
// 分かち書きされていない日本語では語彙統計は参考値 (文字統計は有効)。

// front/lib/api/mime.ts の classify() の audio 集合と対応させること。
export const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus',
  'm4a', 'm4b', 'aac', 'weba', 'aiff', 'aif', 'wma',
])

const TEXT_SIDECAR_EXTS = new Set(['txt', 'json'])

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

function baseOf(name: string): string {
  const e = extOf(name)
  return e ? name.slice(0, -(e.length + 1)) : name
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXTS.has(extOf(name))
}

// WebDataset 規約: 同じ basename の音声 + テキストサイドカーのペア。
// 入力順を保った音声リストに対し、.txt を優先、無ければ .json を対応付ける。
export function pairWebdataset(
  names: string[],
): Array<{ audio: string; text: string | null }> {
  const textByBase = new Map<string, string>()
  for (const n of names) {
    const e = extOf(n)
    if (!TEXT_SIDECAR_EXTS.has(e)) continue
    const base = baseOf(n)
    const prev = textByBase.get(base)
    // .txt 優先
    if (!prev || (extOf(prev) === 'json' && e === 'txt')) textByBase.set(base, n)
  }
  const out: Array<{ audio: string; text: string | null }> = []
  for (const n of names) {
    if (!isAudioName(n)) continue
    out.push({ audio: n, text: textByBase.get(baseOf(n)) ?? null })
  }
  return out
}

// duration ヒストグラムのバケット上限 (秒)。最後のバケットは le=null (それ超)。
export const DURATION_BUCKET_EDGES = [1, 2, 4, 8, 15, 30, 60] as const

export interface DatasetStatsResult {
  fileCount: number
  totalDurationSec: number
  durationHistogram: Array<{ le: number | null; count: number }>
  sampleRates: Record<string, number>
  textFileCount: number
  vocabSize: number
  vocabTruncated: boolean
  charSet: number
  topWords: Array<[string, number]>
  truncated: boolean
}

export class DatasetStatsAccumulator {
  private readonly vocabLimit: number
  private fileCount = 0
  private totalDurationSec = 0
  private histogram: number[] = new Array(DURATION_BUCKET_EDGES.length + 1).fill(0)
  private sampleRates = new Map<number, number>()
  private textFileCount = 0
  private vocab = new Map<string, number>()
  private vocabTruncated = false
  private chars = new Set<string>()
  private truncated = false

  constructor(opts: { vocabLimit?: number } = {}) {
    this.vocabLimit = opts.vocabLimit ?? 100_000
  }

  addAudio(durationSec: number | null, sampleRate: number | null): void {
    this.fileCount++
    if (durationSec != null) {
      this.totalDurationSec += durationSec
      let idx = DURATION_BUCKET_EDGES.findIndex(le => durationSec <= le)
      if (idx === -1) idx = DURATION_BUCKET_EDGES.length
      this.histogram[idx]++
    }
    if (sampleRate != null) {
      this.sampleRates.set(sampleRate, (this.sampleRates.get(sampleRate) ?? 0) + 1)
    }
  }

  addText(text: string): void {
    this.textFileCount++
    for (const tok of text.split(/\s+/)) {
      if (!tok) continue
      const cur = this.vocab.get(tok)
      if (cur != null) {
        this.vocab.set(tok, cur + 1)
      } else if (this.vocab.size < this.vocabLimit) {
        this.vocab.set(tok, 1)
      } else {
        this.vocabTruncated = true
      }
    }
    for (const ch of text) {
      if (!/\s/.test(ch)) this.chars.add(ch)
    }
  }

  markTruncated(): void {
    this.truncated = true
  }

  result(): DatasetStatsResult {
    const topWords = [...this.vocab.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 50)
    return {
      fileCount: this.fileCount,
      totalDurationSec: this.totalDurationSec,
      durationHistogram: [
        ...DURATION_BUCKET_EDGES.map((le, i) => ({ le: le as number | null, count: this.histogram[i] })),
        { le: null, count: this.histogram[DURATION_BUCKET_EDGES.length] },
      ],
      sampleRates: Object.fromEntries(
        [...this.sampleRates.entries()].map(([k, v]) => [String(k), v]),
      ),
      textFileCount: this.textFileCount,
      vocabSize: this.vocab.size,
      vocabTruncated: this.vocabTruncated,
      charSet: this.chars.size,
      topWords,
      truncated: this.truncated,
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/media-stats.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/lib/media-stats.ts api/lib/media-stats.test.ts
git commit -m "feat: データセット統計の集計ロジックと WebDataset ペアリングを追加"
```

---

### Task 5: ffmpeg 解析ラッパー (analyzeAudio)

**Files:**
- Create: `api/lib/media-analyze.ts`
- Create: `api/lib/test-fixtures/tone.wav`（テスト用 1 秒 440Hz、Step 1 で生成）
- Test: `api/lib/media-analyze.test.ts`

**Interfaces:**
- Consumes: `PeakAccumulator` (Task 3)
- Produces:
  - `export interface AnalyzeResult { peaks: Array<[number, number]>; durationSec: number; sampleRate: number | null; spectrogramPng: Buffer | null }`
  - `export async function analyzeAudio(opts: { openStream: () => Promise<NodeJS.ReadableStream>; probeHead: () => Promise<Buffer>; timeoutMs: number; maxSpectrogramWidth: number; signal?: AbortSignal }): Promise<AnalyzeResult>`
  - 失敗時は `MediaAnalyzeError`（`export class MediaAnalyzeError extends Error`、`stderrSummary: string` を持つ）を throw
- ffmpeg は 2 パス（ピーク→スペクトログラム）。`openStream` はパスごとに呼ばれる（計 2 回）。`probeHead` は先頭バイト列（256KiB 目安）を返し、ffprobe で sample_rate を取る
- Buffer から解析したい呼び出し側（tar エントリ / スキャン）は `openStream: async () => Readable.from(buf)` を渡せばよい

- [ ] **Step 1: テスト fixture を生成する**

```bash
cd api && ffmpeg -y -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 lib/test-fixtures/tone.wav
```

Expected: `lib/test-fixtures/tone.wav`（約 32KB）が生成される

- [ ] **Step 2: 失敗するテストを書く**

`api/lib/media-analyze.test.ts`:

```ts
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { analyzeAudio, MediaAnalyzeError } from './media-analyze.js'

const FIXTURE = new URL('./test-fixtures/tone.wav', import.meta.url).pathname

// ffmpeg が無い環境ではスキップ (CI は media-worker コンテナ内で実行する前提)
const hasFfmpeg = await (async () => {
  const { execFile } = await import('node:child_process')
  return new Promise<boolean>(resolve => {
    execFile('ffmpeg', ['-version'], err => resolve(!err))
  })
})()

describe.skipIf(!hasFfmpeg)('analyzeAudio', () => {
  const opts = () => ({
    openStream: async () => createReadStream(FIXTURE) as NodeJS.ReadableStream,
    probeHead: async () => (await readFile(FIXTURE)).subarray(0, 256 * 1024) as Buffer,
    timeoutMs: 30_000,
    maxSpectrogramWidth: 4096,
  })

  it('1 秒の wav から duration / sampleRate / peaks / spectrogram を得る', async () => {
    const r = await analyzeAudio(opts())
    expect(r.durationSec).toBeGreaterThan(0.9)
    expect(r.durationSec).toBeLessThan(1.1)
    expect(r.sampleRate).toBe(16000)
    expect(r.peaks.length).toBeGreaterThan(0)
    expect(r.peaks.length).toBeLessThanOrEqual(2000)
    // 440Hz サイン波: ピークは ±1 近辺
    expect(Math.max(...r.peaks.map(p => p[1]))).toBeGreaterThan(0.5)
    // PNG マジックナンバー
    expect(r.spectrogramPng?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }, 60_000)

  it('非音声データは MediaAnalyzeError', async () => {
    const junk = Buffer.from('not audio at all')
    await expect(analyzeAudio({
      openStream: async () => Readable.from(junk) as NodeJS.ReadableStream,
      probeHead: async () => junk,
      timeoutMs: 30_000,
      maxSpectrogramWidth: 4096,
    })).rejects.toBeInstanceOf(MediaAnalyzeError)
  }, 60_000)
})
```

- [ ] **Step 3: 失敗を確認**

Run: `cd api && npx vitest run lib/media-analyze.test.ts`
Expected: FAIL（モジュールが存在しない）。ffmpeg 無しの環境なら skip 表示になるので、その場合は `brew install ffmpeg` してから進む

- [ ] **Step 4: 実装**

`api/lib/media-analyze.ts`:

```ts
// ffmpeg / ffprobe を子プロセスで叩いて音声を解析する。入力は常に stdin パイプ
// (S3 ストリーム or Buffer) — ファイルには書かない。
//
// パス構成 (stdout が 1 本しかないため 2 パス。openStream はパスごとに呼ばれる):
//   1. ffprobe (probeHead のみ) : sample_rate
//   2. ffmpeg -f f32le          : ピーク集計 + 総サンプル数 → duration
//   3. ffmpeg showspectrumpic   : スペクトログラム PNG (duration から幅を決める)

import { spawn } from 'node:child_process'
import { PeakAccumulator } from './media-peaks.js'

export class MediaAnalyzeError extends Error {
  constructor(message: string, public stderrSummary: string) {
    super(message)
  }
}

export interface AnalyzeResult {
  peaks: Array<[number, number]>
  durationSec: number
  sampleRate: number | null
  spectrogramPng: Buffer | null
}

export interface AnalyzeOpts {
  openStream: () => Promise<NodeJS.ReadableStream>
  probeHead: () => Promise<Buffer>
  timeoutMs: number
  maxSpectrogramWidth: number
  signal?: AbortSignal
}

const PEAK_SAMPLE_RATE = 16000
const SPECTROGRAM_HEIGHT = 256
const SPECTROGRAM_PX_PER_SEC = 50
const SPECTROGRAM_MIN_WIDTH = 640

interface RunResult {
  stdout: Buffer
  stderr: string
  code: number | null
}

// 子プロセスを起動し、input を stdin に流し、stdout を集める。
// onStdout を渡すと stdout はバッファせずチャンクごとに渡す (ピークパス用)。
function run(
  cmd: string,
  args: string[],
  input: NodeJS.ReadableStream | Buffer,
  opts: { timeoutMs: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      fail(new MediaAnalyzeError(`${cmd} timed out`, stderr.slice(-2000)))
    }, opts.timeoutMs)

    const onAbort = (): void => {
      fail(new MediaAnalyzeError('aborted', ''))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function cleanup(): void {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      child.kill('SIGKILL')
    }
    function fail(err: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    child.on('error', e => fail(new MediaAnalyzeError(e.message, '')))
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.stdout.on('data', (c: Buffer) => {
      if (opts.onStdout) opts.onStdout(c)
      else stdoutChunks.push(c)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code })
    })

    // stdin へ流し込む。ffmpeg はヘッダを読んだ時点で stdin を閉じることがある
    // (EPIPE) — 正常系なので無視する。
    child.stdin.on('error', () => { /* EPIPE — ffmpeg 側が先に閉じた */ })
    if (Buffer.isBuffer(input)) {
      child.stdin.end(input)
    } else {
      input.pipe(child.stdin)
      input.on('error', () => child.stdin.end())
    }
  })
}

async function probeSampleRate(head: Buffer, opts: AnalyzeOpts): Promise<number | null> {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate',
    '-of', 'json',
    'pipe:0',
  ], head, { timeoutMs: opts.timeoutMs, signal: opts.signal })
  try {
    const parsed = JSON.parse(r.stdout.toString()) as {
      streams?: Array<{ sample_rate?: string }>
    }
    const sr = parsed.streams?.[0]?.sample_rate
    return sr ? Number(sr) : null
  } catch {
    return null
  }
}

export async function analyzeAudio(opts: AnalyzeOpts): Promise<AnalyzeResult> {
  // パス 1: ffprobe (先頭バイトのみ)
  const sampleRate = await probeSampleRate(await opts.probeHead(), opts)

  // パス 2: ピーク + duration
  const acc = new PeakAccumulator()
  let carry: Buffer = Buffer.alloc(0)
  const peakRun = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE),
    '-f', 'f32le', 'pipe:1',
  ], await opts.openStream(), {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onStdout: chunk => {
      // f32le: 4 byte 境界にそろえて Float32Array 化。端数は次チャンクへ持ち越す。
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 4)
      carry = buf.subarray(usable)
      if (usable === 0) return
      const aligned = new Uint8Array(usable)
      aligned.set(buf.subarray(0, usable))
      acc.push(new Float32Array(aligned.buffer, 0, usable / 4))
    },
  })
  const { peaks, totalSamples } = acc.finish()
  if (peakRun.code !== 0 || totalSamples === 0) {
    throw new MediaAnalyzeError(
      'ffmpeg failed to decode audio',
      peakRun.stderr.slice(-2000),
    )
  }
  const durationSec = totalSamples / PEAK_SAMPLE_RATE

  // パス 3: スペクトログラム PNG
  const width = Math.min(
    opts.maxSpectrogramWidth,
    Math.max(SPECTROGRAM_MIN_WIDTH, Math.round(durationSec * SPECTROGRAM_PX_PER_SEC)),
  )
  const specRun = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-lavfi', `showspectrumpic=s=${width}x${SPECTROGRAM_HEIGHT}:legend=0`,
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], await opts.openStream(), { timeoutMs: opts.timeoutMs, signal: opts.signal })
  // スペクトログラム失敗は致命ではない (ピークだけでも返す)
  const spectrogramPng = specRun.code === 0 && specRun.stdout.length > 0
    ? specRun.stdout
    : null

  return { peaks, durationSec, sampleRate, spectrogramPng }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd api && npx vitest run lib/media-analyze.test.ts`
Expected: PASS (2 tests)（ffmpeg が無い環境では skip — その場合は入れてから通す）

- [ ] **Step 6: Commit**

```bash
git add api/lib/media-analyze.ts api/lib/media-analyze.test.ts api/lib/test-fixtures/tone.wav
git commit -m "feat: ffmpeg による音声解析 (ピーク/スペクトログラム/duration) を追加"
```

---

### Task 6: media_cache ヘルパー (cache_key / get / upsert) + セマフォ

**Files:**
- Create: `api/lib/media-cache.ts`
- Create: `api/lib/semaphore.ts`
- Test: `api/lib/media-cache.test.ts`, `api/lib/semaphore.test.ts`

**Interfaces:**
- Consumes: `AnalyzeResult` (Task 5), `Pools` (`api/db.ts`), Task 1 のテーブル
- Produces:
  - `export interface MediaRef { connId: string; bucket: string; key: string; entryPath?: string; etag: string }`
  - `export function mediaCacheKey(ref: MediaRef): string` — sha256 hex
  - `export interface CachedMedia { cacheKey: string; peaks: Array<[number, number]>; durationSec: number | null; sampleRate: number | null; hasSpectrogram: boolean }`
  - `export async function getCachedMedia(pool: Pool, cacheKey: string): Promise<CachedMedia | null>`
  - `export async function getCachedSpectrogram(pool: Pool, cacheKey: string): Promise<Buffer | null>`
  - `export async function upsertMediaCache(pool: Pool, cacheKey: string, r: AnalyzeResult): Promise<void>`
  - `export function createSemaphore(limit: number): { acquire(): Promise<() => void> }` — FIFO 順で待たせる

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/semaphore.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSemaphore } from './semaphore.js'

describe('createSemaphore', () => {
  it('limit を超える実行は先行の release まで待つ (FIFO)', async () => {
    const sem = createSemaphore(2)
    const order: number[] = []
    const releases: Array<() => void> = []
    const task = async (n: number): Promise<void> => {
      const release = await sem.acquire()
      order.push(n)
      releases.push(release)
    }
    const p1 = task(1)
    const p2 = task(2)
    const p3 = task(3)
    await Promise.resolve()
    await p1
    await p2
    expect(order).toEqual([1, 2]) // 3 はまだ待っている
    releases[0]()
    await p3
    expect(order).toEqual([1, 2, 3])
  })
})
```

`api/lib/media-cache.test.ts`（favorites テストと同じ DB 前提）:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import {
  getCachedMedia,
  getCachedSpectrogram,
  mediaCacheKey,
  upsertMediaCache,
} from './media-cache.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

beforeEach(() => pools.rw.query('TRUNCATE media_cache'))
afterAll(() => closePools(pools))

describe('media-cache', () => {
  it('mediaCacheKey は etag / entryPath を含み決定的', () => {
    const a = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e1' })
    const b = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e1' })
    const c = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e2' })
    const d = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.tar', entryPath: 'a.wav', etag: 'e1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('upsert → get の round trip / spectrogram 有無', async () => {
    const key = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e' })
    expect(await getCachedMedia(pools.ro, key)).toBeNull()
    await upsertMediaCache(pools.rw, key, {
      peaks: [[-0.5, 0.5]],
      durationSec: 1.5,
      sampleRate: 16000,
      spectrogramPng: Buffer.from([1, 2, 3]),
    })
    const got = await getCachedMedia(pools.ro, key)
    expect(got).toEqual({
      cacheKey: key,
      peaks: [[-0.5, 0.5]],
      durationSec: 1.5,
      sampleRate: 16000,
      hasSpectrogram: true,
    })
    expect(await getCachedSpectrogram(pools.ro, key)).toEqual(Buffer.from([1, 2, 3]))
    // 再 upsert は上書き
    await upsertMediaCache(pools.rw, key, {
      peaks: [[0, 0]], durationSec: 2, sampleRate: null, spectrogramPng: null,
    })
    const got2 = await getCachedMedia(pools.ro, key)
    expect(got2?.durationSec).toBe(2)
    expect(got2?.hasSpectrogram).toBe(false)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run lib/semaphore.test.ts lib/media-cache.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`api/lib/semaphore.ts`:

```ts
// FIFO セマフォ。media-worker の同期解析スロット制御に使う。
// 上限超過のリクエストは 503 にせず順番待ちさせる (LAN 内前提)。
export interface Semaphore {
  acquire(): Promise<() => void>
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const waiters: Array<() => void> = []
  const release = (): void => {
    active--
    const next = waiters.shift()
    if (next) next()
  }
  return {
    acquire(): Promise<() => void> {
      if (active < limit) {
        active++
        return Promise.resolve(release)
      }
      return new Promise(resolve => {
        waiters.push(() => {
          active++
          resolve(release)
        })
      })
    },
  }
}
```

`api/lib/media-cache.ts`:

```ts
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { AnalyzeResult } from './media-analyze.js'

export interface MediaRef {
  connId: string
  bucket: string
  key: string
  entryPath?: string
  etag: string
}

// sha256(JSON([connId,bucket,key,entryPath,etag])) — 不透明かつ衝突安全な PK。
// ETag を含めるので S3 側の再アップロードで自然に別キーになる。
export function mediaCacheKey(ref: MediaRef): string {
  return createHash('sha256')
    .update(JSON.stringify([ref.connId, ref.bucket, ref.key, ref.entryPath ?? '', ref.etag]))
    .digest('hex')
}

export interface CachedMedia {
  cacheKey: string
  peaks: Array<[number, number]>
  durationSec: number | null
  sampleRate: number | null
  hasSpectrogram: boolean
}

export async function getCachedMedia(pool: Pool, cacheKey: string): Promise<CachedMedia | null> {
  const r = await pool.query<{
    peaks: Array<[number, number]>
    duration_sec: number | null
    sample_rate: number | null
    has_spec: boolean
  }>(
    `SELECT peaks, duration_sec, sample_rate, (spectrogram IS NOT NULL) AS has_spec
       FROM media_cache WHERE cache_key = $1`,
    [cacheKey],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    cacheKey,
    peaks: row.peaks,
    durationSec: row.duration_sec,
    sampleRate: row.sample_rate,
    hasSpectrogram: row.has_spec,
  }
}

export async function getCachedSpectrogram(pool: Pool, cacheKey: string): Promise<Buffer | null> {
  const r = await pool.query<{ spectrogram: Buffer | null }>(
    'SELECT spectrogram FROM media_cache WHERE cache_key = $1',
    [cacheKey],
  )
  return r.rows[0]?.spectrogram ?? null
}

export async function upsertMediaCache(
  pool: Pool,
  cacheKey: string,
  result: AnalyzeResult & { durationSec: number | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO media_cache (cache_key, peaks, spectrogram, duration_sec, sample_rate)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cache_key) DO UPDATE SET
       peaks = EXCLUDED.peaks,
       spectrogram = EXCLUDED.spectrogram,
       duration_sec = EXCLUDED.duration_sec,
       sample_rate = EXCLUDED.sample_rate,
       created_at = now()`,
    [
      cacheKey,
      JSON.stringify(result.peaks),
      result.spectrogramPng,
      result.durationSec,
      result.sampleRate,
    ],
  )
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/semaphore.test.ts lib/media-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/lib/semaphore.ts api/lib/semaphore.test.ts api/lib/media-cache.ts api/lib/media-cache.test.ts
git commit -m "feat: media_cache ヘルパーと FIFO セマフォを追加"
```

---

### Task 7: tar エントリ逐次イテレータ (スキャン用)

**Files:**
- Create: `api/lib/tar-iterate.ts`
- Test: `api/lib/tar-iterate.test.ts`

**Interfaces:**
- Consumes: 既存 `api/lib/tar-stream.ts` と同じ npm `tar-stream` パッケージ（`import { extract } from 'tar-stream'` — 既存 `tar-stream.ts` の import 行を確認して同じ形を使う）、`ArchiveKind`（`'tar' | 'gz' | 'xz'`）と解凍パイプの組み立ては既存 `tar-stream.ts` の実装を参照（`listTarEntries` が使う gunzip / lzma パイプと同じもの。可能ならそこから解凍ヘルパーを export に切り出して共用する）
- Produces:
  - `export async function iterateTarEntries(stream: NodeJS.ReadableStream, kind: ArchiveKind, onEntry: (header: { name: string; size: number }, body: Buffer) => Promise<void>, opts: { entryMaxBytes: number }): Promise<void>`
  - tar を **1 パス** で読み、通常ファイルエントリごとに本体を Buffer（`entryMaxBytes` 超過はそのエントリを skip）にして `onEntry` を await する。スキャンはこれで「S3 から tar を 1 回流すだけ」で全エントリを解析できる（エントリごとに ffmpeg 2 パスは Buffer からなので追加 S3 アクセスなし）

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/tar-iterate.test.ts`（fixture は tar-stream.test.ts が使っているものを流用。無ければ `tar-stream` の `pack()` でオンザフライ生成する下記の形）:

```ts
import { describe, expect, it } from 'vitest'
import { pack } from 'tar-stream'
import { iterateTarEntries } from './tar-iterate.js'

function makeTar(entries: Array<[string, Buffer]>): NodeJS.ReadableStream {
  const p = pack()
  for (const [name, body] of entries) p.entry({ name }, body)
  p.finalize()
  return p
}

describe('iterateTarEntries', () => {
  it('全エントリを順に body 付きで yield する', async () => {
    const tar = makeTar([
      ['a.wav', Buffer.from('AAAA')],
      ['a.txt', Buffer.from('hello')],
    ])
    const seen: Array<[string, string]> = []
    await iterateTarEntries(tar, 'tar', async (h, body) => {
      seen.push([h.name, body.toString()])
    }, { entryMaxBytes: 1024 })
    expect(seen).toEqual([['a.wav', 'AAAA'], ['a.txt', 'hello']])
  })

  it('entryMaxBytes 超過のエントリは skip して続行する', async () => {
    const tar = makeTar([
      ['big.wav', Buffer.alloc(100)],
      ['small.txt', Buffer.from('ok')],
    ])
    const seen: string[] = []
    await iterateTarEntries(tar, 'tar', async h => { seen.push(h.name) }, { entryMaxBytes: 10 })
    expect(seen).toEqual(['small.txt'])
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run lib/tar-iterate.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`api/lib/tar-iterate.ts`（解凍パイプは既存 `tar-stream.ts` の `listTarEntries` 実装と同じ組み立てを使うこと。以下は gz を zlib、xz を lzma-native とした場合の形 — 実際の import は既存ファイルに合わせる）:

```ts
// tar (無圧縮 / gz / xz) を 1 パスで読み、エントリごとに本体 Buffer を
// コールバックへ渡す。データセットスキャン用: S3 から tar を 1 回流すだけで
// 中の全音声を解析できるようにする。
import { extract } from 'tar-stream'
import { createGunzip } from 'node:zlib'
import type { ArchiveKind } from './tar-stream.js'

export interface TarEntryHeader {
  name: string
  size: number
}

export async function iterateTarEntries(
  stream: NodeJS.ReadableStream,
  kind: ArchiveKind,
  onEntry: (header: TarEntryHeader, body: Buffer) => Promise<void>,
  opts: { entryMaxBytes: number },
): Promise<void> {
  let source: NodeJS.ReadableStream = stream
  if (kind === 'gz') {
    const gunzip = createGunzip()
    stream.pipe(gunzip)
    source = gunzip
  } else if (kind === 'xz') {
    // 既存 tar-stream.ts と同じ lzma-native の Decompressor を使う
    const lzma = await import('lzma-native')
    const dec = lzma.createDecompressor()
    stream.pipe(dec)
    source = dec as unknown as NodeJS.ReadableStream
  }

  const ex = extract()
  source.pipe(ex)

  for await (const entry of ex) {
    const header = entry.header
    const isFile = header.type === 'file'
    const size = header.size ?? 0
    if (!isFile || size > opts.entryMaxBytes) {
      entry.resume() // 本体を読み捨てて次へ
      continue
    }
    const chunks: Buffer[] = []
    for await (const chunk of entry) chunks.push(chunk as Buffer)
    await onEntry({ name: header.name, size }, Buffer.concat(chunks))
  }
}
```

注意: `extract()` の async iterator 対応はバージョンに依る。既存 `tar-stream.ts` がイベントベース（`ex.on('entry', ...)`）で書かれていたら、それに合わせてイベントベースで書き直すこと（`entry` イベント内で chunks を集めて `next()` を呼ぶ形）。テストが通る実装が正。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/tar-iterate.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/lib/tar-iterate.ts api/lib/tar-iterate.test.ts
git commit -m "feat: tar エントリの 1 パス逐次イテレータを追加"
```

---

### Task 8: media サービス (同期解析 + スキャン実行) と worker エントリポイント

**Files:**
- Create: `api/lib/media-service.ts`
- Create: `api/worker.ts`
- Test: `api/lib/media-service.test.ts`

**Interfaces:**
- Consumes: `analyzeAudio` / `MediaAnalyzeError` (Task 5), `mediaCacheKey` / `upsertMediaCache` / `getCachedMedia` (Task 6), `createSemaphore` (Task 6), `PeakAccumulator` 経由の結果, `DatasetStatsAccumulator` / `pairWebdataset` / `isAudioName` (Task 4), `iterateTarEntries` (Task 7), `StorageFactory`（`api/storage.ts` の `getStorage` / `getConnectionConfig`）, `Pools`
- Produces:
  - `export interface AnalyzeRequest { connId: string; bucket: string; key: string; entryPath?: string; etag: string }`
  - `export interface AnalyzeResponse { cacheKey: string; peaks: Array<[number, number]>; durationSec: number | null; sampleRate: number | null; hasSpectrogram: boolean }`
  - `export function createMediaService(deps: { pools: Pools; getStorage: GetStorage; getConnectionConfig: (connId: string) => Promise<ConnectionConfig>; env: Env }): MediaService`
  - `interface MediaService { analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse>; runNextScanJob(): Promise<boolean>; requeueStale(): Promise<void>; cleanup(): Promise<void> }`
  - `runNextScanJob()` は 1 件処理したら true、queued が無ければ false
- `worker.ts` は compose から起動される実行ファイル: 内部 HTTP（`POST /analyze`、`GET /healthz`）+ ジョブループ + 起動時 `requeueStale()` + 1 時間ごと `cleanup()`

- [ ] **Step 1: 失敗するテストを書く**

`api/lib/media-service.test.ts`（S3 はスタブ、ffmpeg 依存を避けるため `analyzeAudio` を vi.mock する）:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { createPools, closePools } from '../db.js'
import { loadEnv } from '../env.js'
import type { ConnectionConfig } from '../storage.js'

vi.mock('./media-analyze.js', async importOriginal => {
  const mod = await importOriginal<typeof import('./media-analyze.js')>()
  return {
    ...mod,
    analyzeAudio: vi.fn(async () => ({
      peaks: [[-0.1, 0.1]] as Array<[number, number]>,
      durationSec: 2.5,
      sampleRate: 16000,
      spectrogramPng: Buffer.from([0x89, 0x50]),
    })),
  }
})
const { createMediaService } = await import('./media-service.js')
const { getCachedMedia, mediaCacheKey } = await import('./media-cache.js')

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

const env = loadEnv({
  DATABASE_URL_RW: RW,
  DATABASE_URL_RO: RW,
  ENCRYPTION_KEY: '0'.repeat(64),
  ALLOWED_ORIGINS: 'http://localhost:5173',
})

// GetObjectCommand / HeadObjectCommand / ListObjectsV2Command に応答する S3 スタブ。
// keys: key -> body。list は全キーを 1 ページで返す。
function stubStorage(keys: Record<string, Buffer>): S3Client {
  return {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name
      const key = cmd.input.Key as string
      if (name === 'GetObjectCommand') {
        const body = keys[key]
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        return { Body: Readable.from(body), ContentLength: body.length }
      }
      if (name === 'HeadObjectCommand') {
        const body = keys[key]
        if (!body) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
        return { ETag: '"stub-etag"', ContentLength: body.length }
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (cmd.input.Prefix as string) ?? ''
        return {
          Contents: Object.entries(keys)
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ Key: k, Size: v.length })),
          IsTruncated: false,
        }
      }
      throw new Error(`unexpected command ${name}`)
    },
  } as unknown as S3Client
}

function makeService(keys: Record<string, Buffer>) {
  return createMediaService({
    pools,
    getStorage: async () => stubStorage(keys),
    getConnectionConfig: async () => ({ listObjectsVersion: 'v2' } as ConnectionConfig),
    env,
  })
}

beforeEach(async () => {
  await pools.rw.query('TRUNCATE media_cache, media_jobs, dataset_stats')
})
afterAll(() => closePools(pools))

describe('analyzeOne', () => {
  it('解析して media_cache に保存し、2 回目はキャッシュから返す', async () => {
    const svc = makeService({ 'a.wav': Buffer.from('fake') })
    const req = { connId: 'c1', bucket: 'b', key: 'a.wav', etag: 'stub-etag' }
    const r1 = await svc.analyzeOne(req)
    expect(r1.durationSec).toBe(2.5)
    expect(r1.hasSpectrogram).toBe(true)
    expect(r1.cacheKey).toBe(mediaCacheKey(req))
    const cached = await getCachedMedia(pools.ro, r1.cacheKey)
    expect(cached?.durationSec).toBe(2.5)
    // 2 回目 — analyzeAudio は追加で呼ばれない
    const { analyzeAudio } = await import('./media-analyze.js')
    const calls = (analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length
    const r2 = await svc.analyzeOne(req)
    expect(r2).toEqual(r1)
    expect((analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })
})

describe('runNextScanJob', () => {
  it('prefix スキャン: 音声を解析して dataset_stats を書き、ジョブを done にする', async () => {
    const svc = makeService({
      'ds/u1.wav': Buffer.from('a'),
      'ds/u1.txt': Buffer.from('hello world'),
      'ds/u2.wav': Buffer.from('b'),
      'ds/readme.md': Buffer.from('x'),
    })
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2)`,
      ['c1\nb\nds/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds/' })],
    )
    expect(await svc.runNextScanJob()).toBe(true)
    const job = (await pools.ro.query('SELECT status, progress FROM media_jobs')).rows[0]
    expect(job.status).toBe('done')
    const stats = (await pools.ro.query('SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nds/'])).rows[0]
    expect(stats.result.fileCount).toBe(2)          // u1.wav, u2.wav
    expect(stats.result.textFileCount).toBe(1)      // u1.txt
    expect(stats.result.totalDurationSec).toBeCloseTo(5) // 2.5 × 2 (mock)
    // キャッシュも温まっている
    const cacheCount = (await pools.ro.query('SELECT count(*)::int AS n FROM media_cache')).rows[0]
    expect(cacheCount.n).toBe(2)
  })

  it('queued が無ければ false', async () => {
    const svc = makeService({})
    expect(await svc.runNextScanJob()).toBe(false)
  })

  it('canceled ジョブはファイル境界で中断される', async () => {
    const svc = makeService({ 'ds/u1.wav': Buffer.from('a'), 'ds/u2.wav': Buffer.from('b') })
    const ins = await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2) RETURNING id`,
      ['c1\nb\nds/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds/' })],
    )
    // 実行前にキャンセル
    await pools.rw.query(`UPDATE media_jobs SET status='canceled' WHERE id=$1`, [ins.rows[0].id])
    expect(await svc.runNextScanJob()).toBe(false) // queued が無いので拾わない
    const stats = await pools.ro.query('SELECT count(*)::int AS n FROM dataset_stats')
    expect(stats.rows[0].n).toBe(0)
  })
})

describe('requeueStale', () => {
  it('processing のまま残ったジョブを queued に戻す', async () => {
    const svc = makeService({})
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload, status, started_at)
       VALUES ('x', '{}', 'processing', now())`,
    )
    await svc.requeueStale()
    const r = await pools.ro.query('SELECT status FROM media_jobs')
    expect(r.rows[0].status).toBe('queued')
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run lib/media-service.test.ts`
Expected: FAIL（`media-service.js` が存在しない）

- [ ] **Step 3: media-service.ts を実装**

`api/lib/media-service.ts`:

```ts
// media-worker の中核。単一ファイルの同期解析 (analyzeOne) と、
// ディレクトリ / tar スキャンのジョブ実行 (runNextScanJob) を提供する。
// worker.ts (HTTP + ループ) から使われる。api コンテナはこれを import しない
// (ffmpeg は worker にしか無い)。
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import { Readable as ReadableCtor } from 'node:stream'
import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import type { ConnectionConfig } from '../storage.js'
import type { GetStorage } from '../routes/_connId.js'
import { analyzeAudio, MediaAnalyzeError, type AnalyzeResult } from './media-analyze.js'
import {
  getCachedMedia,
  mediaCacheKey,
  upsertMediaCache,
  type CachedMedia,
  type MediaRef,
} from './media-cache.js'
import { createSemaphore } from './semaphore.js'
import {
  DatasetStatsAccumulator,
  isAudioName,
  pairWebdataset,
} from './media-stats.js'
import { extractTarEntry, type ArchiveKind } from './tar-stream.js'
import { iterateTarEntries } from './tar-iterate.js'

export type AnalyzeRequest = MediaRef

export type AnalyzeResponse = CachedMedia

export interface MediaServiceDeps {
  pools: Pools
  getStorage: GetStorage
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
  env: Env
}

export interface MediaService {
  analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse>
  runNextScanJob(): Promise<boolean>
  requeueStale(): Promise<void>
  cleanup(): Promise<void>
}

const PROBE_HEAD_BYTES = 256 * 1024
// tar 内エントリを解析するときの 1 エントリ上限 (storage-preview.ts の
// TAR_ENTRY_MAX_BYTES と同値)。
const ENTRY_MAX_BYTES = 100 * 1024 * 1024

function detectArchive(key: string): ArchiveKind | null {
  const k = key.toLowerCase()
  if (k.endsWith('.tar.gz') || k.endsWith('.tgz')) return 'gz'
  if (k.endsWith('.tar.xz')) return 'xz'
  if (k.endsWith('.tar')) return 'tar'
  return null
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const sem = createSemaphore(deps.env.MEDIA_CONCURRENCY)
  const timeoutMs = deps.env.MEDIA_ANALYZE_TIMEOUT_SEC * 1000

  async function openObjectStream(storage: S3Client, bucket: string, key: string, range?: string): Promise<NodeJS.ReadableStream> {
    const r = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }))
    return r.Body as unknown as Readable
  }

  // Buffer から解析する (tar エントリ / スキャン内)。openStream は 2 回呼ばれても
  // Buffer なので追加 I/O なし。
  function analyzeBuffer(buf: Buffer, signal?: AbortSignal): Promise<AnalyzeResult> {
    return analyzeAudio({
      openStream: async () => ReadableCtor.from(buf) as NodeJS.ReadableStream,
      probeHead: async () => buf.subarray(0, PROBE_HEAD_BYTES),
      timeoutMs,
      maxSpectrogramWidth: deps.env.MEDIA_SPECTROGRAM_MAX_WIDTH,
      signal,
    })
  }

  async function analyzeAndCache(
    ref: MediaRef,
    doAnalyze: () => Promise<AnalyzeResult>,
  ): Promise<AnalyzeResponse> {
    const cacheKey = mediaCacheKey(ref)
    const cached = await getCachedMedia(deps.pools.ro, cacheKey)
    if (cached) return cached
    const result = await doAnalyze()
    await upsertMediaCache(deps.pools.rw, cacheKey, result)
    return {
      cacheKey,
      peaks: result.peaks,
      durationSec: result.durationSec,
      sampleRate: result.sampleRate,
      hasSpectrogram: result.spectrogramPng != null,
    }
  }

  async function analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse> {
    const release = await sem.acquire()
    try {
      const storage = await deps.getStorage(req.connId)
      if (req.entryPath) {
        // tar 内エントリ: 全ストリームを 1 回流してエントリを Buffer 化 → Buffer から解析
        const kind = detectArchive(req.key)
        if (!kind) throw new MediaAnalyzeError('not an archive', '')
        return await analyzeAndCache(req, async () => {
          const stream = await openObjectStream(storage, req.bucket, req.key)
          const extracted = await extractTarEntry(stream, kind, req.entryPath!, ENTRY_MAX_BYTES)
          if (!extracted || extracted.truncated) {
            throw new MediaAnalyzeError('entry not found or too large', '')
          }
          return analyzeBuffer(extracted.buffer, signal)
        })
      }
      return await analyzeAndCache(req, () => analyzeAudio({
        openStream: () => openObjectStream(storage, req.bucket, req.key),
        probeHead: async () => {
          const head = await openObjectStream(
            storage, req.bucket, req.key, `bytes=0-${PROBE_HEAD_BYTES - 1}`,
          )
          return readAll(head)
        },
        timeoutMs,
        maxSpectrogramWidth: deps.env.MEDIA_SPECTROGRAM_MAX_WIDTH,
        signal,
      }))
    } finally {
      release()
    }
  }

  // ── スキャン ──────────────────────────────────────────────

  interface ScanPayload {
    connId: string
    bucket: string
    prefix?: string
    tarKey?: string
  }

  async function listAllKeys(
    storage: S3Client,
    connId: string,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const cfg = await deps.getConnectionConfig(connId)
    const keys: string[] = []
    if (cfg.listObjectsVersion === 'v1') {
      let marker: string | undefined
      for (;;) {
        const out = await storage.send(new ListObjectsCommand({
          Bucket: bucket, Prefix: prefix, Marker: marker, MaxKeys: 1000,
        }))
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key)
        if (!out.IsTruncated || keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) break
        marker = out.NextMarker ?? keys[keys.length - 1]
      }
    } else {
      let token: string | undefined
      for (;;) {
        const out = await storage.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
        }))
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key)
        if (!out.IsTruncated || keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) break
        token = out.NextContinuationToken
      }
    }
    return keys
  }

  async function isCanceled(jobId: number): Promise<boolean> {
    const r = await deps.pools.ro.query<{ status: string }>(
      'SELECT status FROM media_jobs WHERE id = $1', [jobId],
    )
    return r.rows[0]?.status === 'canceled'
  }

  async function setProgress(jobId: number, p: { filesDone: number; filesTotal: number; currentKey: string }): Promise<void> {
    await deps.pools.rw.query(
      'UPDATE media_jobs SET progress = $2 WHERE id = $1',
      [jobId, JSON.stringify(p)],
    )
  }

  async function scanTarget(jobId: number, payload: ScanPayload): Promise<'done' | 'canceled'> {
    const storage = await deps.getStorage(payload.connId)
    const acc = new DatasetStatsAccumulator()

    // 統計に加えつつキャッシュも温める共通処理
    const analyzeEntry = async (ref: MediaRef, body: Buffer): Promise<void> => {
      try {
        const r = await analyzeAndCache(ref, () => analyzeBuffer(body))
        acc.addAudio(r.durationSec, r.sampleRate)
      } catch (e) {
        if (e instanceof MediaAnalyzeError) {
          acc.addAudio(null, null) // 解析失敗はカウントのみ (スキャンは続行)
        } else {
          throw e
        }
      }
    }

    const readText = (body: Buffer, name: string): string => {
      const text = body.toString('utf8')
      if (name.toLowerCase().endsWith('.json')) {
        try {
          const j = JSON.parse(text) as { text?: unknown }
          return typeof j.text === 'string' ? j.text : ''
        } catch {
          return ''
        }
      }
      return text
    }

    if (payload.tarKey) {
      // ── tar スキャン: 1 パスで全エントリを処理 ──
      const kind = detectArchive(payload.tarKey)
      if (!kind) throw new Error('unsupported archive extension')
      const etagOut = await storage.send(new HeadObjectCommand({ Bucket: payload.bucket, Key: payload.tarKey }))
      const etag = (etagOut.ETag ?? '').replaceAll('"', '')
      let filesDone = 0
      const stream = await openObjectStream(storage, payload.bucket, payload.tarKey)
      let canceled = false
      await iterateTarEntries(stream, kind, async (header, body) => {
        if (canceled) return
        if (isAudioName(header.name)) {
          await analyzeEntry(
            { connId: payload.connId, bucket: payload.bucket, key: payload.tarKey!, entryPath: header.name, etag },
            body,
          )
          filesDone++
          await setProgress(jobId, { filesDone, filesTotal: -1, currentKey: header.name })
          if (await isCanceled(jobId)) canceled = true
        } else if (/\.(txt|json)$/i.test(header.name)) {
          acc.addText(readText(body, header.name))
        }
      }, { entryMaxBytes: ENTRY_MAX_BYTES })
      if (canceled) return 'canceled'
    } else {
      // ── prefix スキャン ──
      const prefix = payload.prefix ?? ''
      const keys = await listAllKeys(storage, payload.connId, payload.bucket, prefix)
      if (keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) acc.markTruncated()
      const pairs = pairWebdataset(keys)
      const textKeys = new Set(pairs.map(p => p.text).filter((t): t is string => t != null))
      let filesDone = 0
      const filesTotal = pairs.length

      for (const pair of pairs) {
        if (await isCanceled(jobId)) return 'canceled'
        const head = await storage.send(new HeadObjectCommand({ Bucket: payload.bucket, Key: pair.audio }))
        const etag = (head.ETag ?? '').replaceAll('"', '')
        const body = await readAll(await openObjectStream(storage, payload.bucket, pair.audio))
        await analyzeEntry({ connId: payload.connId, bucket: payload.bucket, key: pair.audio, etag }, body)
        filesDone++
        await setProgress(jobId, { filesDone, filesTotal, currentKey: pair.audio })
      }
      for (const tk of textKeys) {
        const body = await readAll(await openObjectStream(storage, payload.bucket, tk))
        acc.addText(readText(body, tk))
      }
    }

    const targetKey = [payload.connId, payload.bucket, payload.tarKey ?? payload.prefix ?? ''].join('\n')
    await deps.pools.rw.query(
      `INSERT INTO dataset_stats (target_key, result, scanned_at)
       VALUES ($1, $2, now())
       ON CONFLICT (target_key) DO UPDATE SET result = EXCLUDED.result, scanned_at = now()`,
      [targetKey, JSON.stringify(acc.result())],
    )
    return 'done'
  }

  async function runNextScanJob(): Promise<boolean> {
    const client = await deps.pools.rw.connect()
    let job: { id: number; payload: ScanPayload } | null = null
    try {
      await client.query('BEGIN')
      const r = await client.query<{ id: number; payload: ScanPayload }>(
        `UPDATE media_jobs SET status = 'processing', started_at = now()
         WHERE id = (
           SELECT id FROM media_jobs WHERE status = 'queued'
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, payload`,
      )
      await client.query('COMMIT')
      job = r.rows[0] ?? null
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
    if (!job) return false

    try {
      const outcome = await scanTarget(job.id, job.payload)
      await deps.pools.rw.query(
        `UPDATE media_jobs SET status = $2, finished_at = now() WHERE id = $1 AND status <> 'canceled'`,
        [job.id, outcome],
      )
    } catch (e) {
      await deps.pools.rw.query(
        `UPDATE media_jobs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`,
        [job.id, (e as Error).message.slice(0, 2000)],
      )
    }
    return true
  }

  async function requeueStale(): Promise<void> {
    await deps.pools.rw.query(
      `UPDATE media_jobs SET status = 'queued', started_at = NULL WHERE status = 'processing'`,
    )
  }

  async function cleanup(): Promise<void> {
    await deps.pools.rw.query(
      `DELETE FROM media_cache WHERE created_at < now() - make_interval(days => $1)`,
      [deps.env.MEDIA_CACHE_MAX_AGE_DAYS],
    )
    await deps.pools.rw.query(
      `DELETE FROM media_jobs
        WHERE status IN ('done', 'error', 'canceled')
          AND finished_at < now() - interval '7 days'`,
    )
  }

  return { analyzeOne, runNextScanJob, requeueStale, cleanup }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run lib/media-service.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: worker.ts を実装**

`api/worker.ts`（テストは media-service 側で済んでいるので配線のみ。パターンは `internal.ts` を踏襲）:

```ts
// api/worker.ts — media-worker コンテナのエントリポイント。
//   ・内部 HTTP (compose ネットワーク内のみ): POST /analyze で同期解析
//   ・ジョブループ: media_jobs (ディレクトリ / tar スキャン) を 1 件ずつ
// api-internal と同じコードベース / .env を共有し、compose で別サービスとして起動。
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { loadEnv } from './env.js'
import { createPools, closePools } from './db.js'
import { createCrypto } from './crypto.js'
import { createStorageFactory } from './storage.js'
import { MediaAnalyzeError } from './lib/media-analyze.js'
import { createMediaService, type AnalyzeRequest } from './lib/media-service.js'

const env = loadEnv()
const pools = createPools({ rw: env.DATABASE_URL_RW, ro: env.DATABASE_URL_RO })
const crypto = createCrypto(env.ENCRYPTION_KEY)
const storageFactory = createStorageFactory({ pools, crypto })
const service = createMediaService({
  pools,
  getStorage: storageFactory.getStorage,
  getConnectionConfig: storageFactory.getConnectionConfig,
  env,
})

const app = new Hono()
app.use('*', logger())
app.get('/healthz', c => c.text('ok'))

app.post('/analyze', async c => {
  const req = (await c.req.json()) as AnalyzeRequest
  if (!req.connId || !req.bucket || !req.key || !req.etag) {
    return c.json({ error: 'connId, bucket, key, etag required' }, 400)
  }
  try {
    // クライアント (api 経由でブラウザ) が切断したら解析を中断して ffmpeg を kill
    const result = await service.analyzeOne(req, c.req.raw.signal)
    return c.json(result)
  } catch (e) {
    if (e instanceof MediaAnalyzeError) {
      return c.json({ error: `解析できませんでした: ${e.message}` }, 422)
    }
    throw e
  }
})

app.onError((err, c) => {
  console.error('worker unhandled error', err)
  return c.json({ error: 'internal error' }, 500)
})

const server = serve({ fetch: app.fetch, port: env.MEDIA_WORKER_PORT }, info => {
  console.log(`media-worker listening on http://localhost:${info.port}`)
})

// ── ジョブループ ──
let stopping = false
async function jobLoop(): Promise<void> {
  await service.requeueStale()
  while (!stopping) {
    try {
      const ran = await service.runNextScanJob()
      if (!ran) await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      console.error('scan job error', e)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
void jobLoop()

const cleanupTimer = setInterval(() => {
  service.cleanup().catch(e => console.error('cleanup error', e))
}, 60 * 60 * 1000)
cleanupTimer.unref()

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  stopping = true
  setTimeout(() => process.exit(1), 10_000).unref()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await storageFactory.close()
  await closePools(pools)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

- [ ] **Step 6: tsc / lint / 全 api テストが通ることを確認**

Run: `cd api && npx tsc --noEmit && npm run lint && npm test`
Expected: 全て PASS

- [ ] **Step 7: Commit**

```bash
git add api/lib/media-service.ts api/lib/media-service.test.ts api/worker.ts
git commit -m "feat: media-worker (同期解析 HTTP + スキャンジョブループ) を追加"
```

---

### Task 9: api ルート storage-media.ts (analyze proxy / spectrogram / scan)

**Files:**
- Create: `api/routes/storage-media.ts`
- Modify: `api/internal.ts`（mount 追加）
- Test: `api/routes/storage-media.test.ts`

**Interfaces:**
- Consumes: `resolveStorageOrFail` / `GetStorage` (`routes/_connId.ts`), `mediaCacheKey` / `getCachedMedia` / `getCachedSpectrogram` / `upsertMediaCache` (Task 6), `Pools`, `Env`
- Produces（フロントが叩く API）:
  - `GET /storage/:connId/media/analyze?bucket&key(&entryPath)` → `200 {cacheKey, peaks, durationSec, sampleRate, hasSpectrogram}` / `422 {error}` / `503 {error}`（worker 不達）
  - `GET /storage/:connId/media/spectrogram?cacheKey` → PNG (`Cache-Control: public, max-age=31536000, immutable`) / 404
  - `POST /storage/:connId/media/scan` body `{bucket, prefix?} | {bucket, tarKey}` → `202 {jobId}`
  - `GET /storage/:connId/media/scan-status?bucket&(prefix|tarKey)` → `200 {job: {id,status,progress,error} | null, stats: object | null, scannedAt: string | null}`
  - `POST /storage/:connId/media/scan-cancel` body `{jobId}` → `200 {ok:true}`
  - `export function mountStorageMediaRoutes(app: Hono, deps: { getStorage: GetStorage; pools: Pools; env: Env; workerFetch?: typeof fetch }): void`（`workerFetch` はテスト用注入、既定 `fetch`）
- target_key の組み立て: `[connId, bucket, tarKey ?? prefix ?? ''].join('\n')`（Task 8 と同一）

- [ ] **Step 1: 失敗するテストを書く**

`api/routes/storage-media.test.ts`:

```ts
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { createPools, closePools } from '../db.js'
import { loadEnv } from '../env.js'
import { mediaCacheKey, upsertMediaCache } from '../lib/media-cache.js'
import { mountStorageMediaRoutes } from './storage-media.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

const env = loadEnv({
  DATABASE_URL_RW: RW,
  DATABASE_URL_RO: RW,
  ENCRYPTION_KEY: '0'.repeat(64),
  ALLOWED_ORIGINS: 'http://localhost:5173',
})

// HeadObject だけ返せばよい (Get は worker 側の仕事)
const stubStorage = {
  send: async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'HeadObjectCommand') {
      return { ETag: '"etag1"', ContentLength: 100 }
    }
    throw new Error('unexpected')
  },
} as unknown as S3Client

const workerFetch = vi.fn()

function makeApp(): Hono {
  const app = new Hono()
  mountStorageMediaRoutes(app, {
    getStorage: async () => stubStorage,
    pools,
    env,
    workerFetch: workerFetch as unknown as typeof fetch,
  })
  return app
}

beforeEach(async () => {
  workerFetch.mockReset()
  await pools.rw.query('TRUNCATE media_cache, media_jobs, dataset_stats')
})
afterAll(() => closePools(pools))

const REF = { connId: 'c1', bucket: 'b', key: 'a.wav', etag: 'etag1' }

describe('GET /media/analyze', () => {
  it('キャッシュ命中なら worker を呼ばず 200', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, spectrogramPng: Buffer.from([1]),
    })
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cacheKey).toBe(cacheKey)
    expect(body.durationSec).toBe(3)
    expect(body.hasSpectrogram).toBe(true)
    expect(workerFetch).not.toHaveBeenCalled()
  })

  it('未計算なら worker に proxy してそのまま返す', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({
      cacheKey: 'k', peaks: [[0, 0]], durationSec: 1, sampleRate: null, hasSpectrogram: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    expect((await res.json()).cacheKey).toBe('k')
    // worker へは etag 込みで POST される
    const [url, init] = workerFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${env.MEDIA_WORKER_URL}/analyze`)
    expect(JSON.parse(init.body as string)).toEqual(REF)
  })

  it('worker 不達なら 503', async () => {
    workerFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(503)
  })

  it('worker の 422 は素通しされる', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'no' }), { status: 422 }))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(422)
  })
})

describe('GET /media/spectrogram', () => {
  it('PNG を immutable Cache-Control 付きで返す / 無ければ 404', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [], durationSec: 1, sampleRate: null, spectrogramPng: Buffer.from([0x89, 0x50]),
    })
    const res = await makeApp().request(`/storage/c1/media/spectrogram?cacheKey=${cacheKey}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    const missing = await makeApp().request('/storage/c1/media/spectrogram?cacheKey=none')
    expect(missing.status).toBe(404)
  })
})

describe('scan lifecycle', () => {
  it('POST scan → 202 / 二重投入は同じジョブに合流 / status で見える / cancel できる', async () => {
    const app = makeApp()
    const r1 = await app.request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect(r1.status).toBe(202)
    const { jobId } = await r1.json()
    const r2 = await app.request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect((await r2.json()).jobId).toBe(jobId)

    const st = await app.request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    const stBody = await st.json()
    expect(stBody.job.id).toBe(jobId)
    expect(stBody.job.status).toBe('queued')
    expect(stBody.stats).toBeNull()

    const cancel = await app.request('/storage/c1/media/scan-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
    expect(cancel.status).toBe(200)
    const st2 = await app.request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    expect((await st2.json()).job.status).toBe('canceled')
  })

  it('done 済みジョブが残っていても再投入できる (部分ユニーク)', async () => {
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload, status, finished_at)
       VALUES ($1, '{}', 'done', now())`,
      ['c1\nb\nds/'],
    )
    const res = await makeApp().request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect(res.status).toBe(202)
  })

  it('dataset_stats があれば scan-status で stats が返る', async () => {
    await pools.rw.query(
      `INSERT INTO dataset_stats (target_key, result, scanned_at) VALUES ($1, $2, now())`,
      ['c1\nb\nds/', JSON.stringify({ fileCount: 5 })],
    )
    const res = await makeApp().request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    const body = await res.json()
    expect(body.stats.fileCount).toBe(5)
    expect(body.scannedAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd api && npx vitest run routes/storage-media.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`api/routes/storage-media.ts`:

```ts
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { Hono } from 'hono'
import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import {
  getCachedMedia,
  getCachedSpectrogram,
  mediaCacheKey,
} from '../lib/media-cache.js'
import { resolveStorageOrFail, type GetStorage } from './_connId.js'

export interface StorageMediaDeps {
  getStorage: GetStorage
  pools: Pools
  env: Env
  // テスト用に注入可能。既定はグローバル fetch。
  workerFetch?: typeof fetch
}

// media_jobs / dataset_stats の target_key。media-service.ts と同一形式。
// '\n' は S3 キーに現れないため安全な区切り。
function targetKey(connId: string, bucket: string, target: string): string {
  return [connId, bucket, target].join('\n')
}

export function mountStorageMediaRoutes(app: Hono, deps: StorageMediaDeps): void {
  const workerFetch = deps.workerFetch ?? fetch

  // 単一ファイルの解析。キャッシュ命中は即返し、未計算は media-worker に
  // 同期 proxy する (キューは通らない)。202 は返さない。
  app.get('/storage/:connId/media/analyze', async c => {
    const r0 = await resolveStorageOrFail(c, deps.getStorage)
    if (r0 instanceof Response) return r0
    const storage = r0
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    const key = c.req.query('key')
    const entryPath = c.req.query('entryPath') || undefined
    if (!bucket || !key) {
      return c.json({ error: 'bucket and key required' }, 400)
    }

    let etag: string
    try {
      const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      etag = (head.ETag ?? '').replaceAll('"', '')
    } catch {
      return c.json({ error: 'not found' }, 404)
    }

    const ref = { connId, bucket, key, entryPath, etag }
    const cached = await getCachedMedia(deps.pools.ro, mediaCacheKey(ref))
    if (cached) return c.json(cached)

    // worker へ同期 proxy。ブラウザが切断したら中断が伝播する。
    let workerRes: Response
    try {
      workerRes = await workerFetch(`${deps.env.MEDIA_WORKER_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ref),
        signal: c.req.raw.signal,
      })
    } catch {
      return c.json({ error: 'media-worker に接続できません' }, 503)
    }
    return new Response(workerRes.body, {
      status: workerRes.status,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  app.get('/storage/:connId/media/spectrogram', async c => {
    const cacheKey = c.req.query('cacheKey')
    if (!cacheKey) return c.json({ error: 'cacheKey required' }, 400)
    const png = await getCachedSpectrogram(deps.pools.ro, cacheKey)
    if (!png) return c.json({ error: 'not found' }, 404)
    const body = new Uint8Array(png.byteLength)
    body.set(png)
    return new Response(body, {
      headers: {
        'Content-Type': 'image/png',
        // cacheKey は ETag 込みハッシュなので内容は不変
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  })

  // ディレクトリ / tar スキャンをキューに投入する (これだけがキューを通る)。
  app.post('/storage/:connId/media/scan', async c => {
    const connId = c.req.param('connId')
    const body = (await c.req.json()) as { bucket?: string; prefix?: string; tarKey?: string }
    if (!body.bucket || (body.prefix == null && !body.tarKey)) {
      return c.json({ error: 'bucket and prefix or tarKey required' }, 400)
    }
    const target = body.tarKey ?? body.prefix ?? ''
    const tk = targetKey(connId, body.bucket, target)
    const payload = {
      connId,
      bucket: body.bucket,
      ...(body.tarKey ? { tarKey: body.tarKey } : { prefix: body.prefix ?? '' }),
    }
    // 部分ユニークインデックス (queued/processing のみ) と競合したら既存ジョブに合流
    const ins = await deps.pools.rw.query<{ id: number }>(
      `INSERT INTO media_jobs (target_key, payload)
       VALUES ($1, $2)
       ON CONFLICT (target_key) WHERE status IN ('queued','processing') DO NOTHING
       RETURNING id`,
      [tk, JSON.stringify(payload)],
    )
    let jobId = ins.rows[0]?.id
    if (jobId == null) {
      const existing = await deps.pools.ro.query<{ id: number }>(
        `SELECT id FROM media_jobs
          WHERE target_key = $1 AND status IN ('queued','processing')
          ORDER BY id DESC LIMIT 1`,
        [tk],
      )
      jobId = existing.rows[0]?.id
    }
    return c.json({ jobId }, 202)
  })

  app.get('/storage/:connId/media/scan-status', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    const prefix = c.req.query('prefix')
    const tarKey = c.req.query('tarKey')
    if (!bucket || (prefix == null && !tarKey)) {
      return c.json({ error: 'bucket and prefix or tarKey required' }, 400)
    }
    const tk = targetKey(connId, bucket, tarKey ?? prefix ?? '')
    const jobR = await deps.pools.ro.query<{
      id: number
      status: string
      progress: unknown
      error: string | null
    }>(
      `SELECT id, status, progress, error FROM media_jobs
        WHERE target_key = $1 ORDER BY id DESC LIMIT 1`,
      [tk],
    )
    const statsR = await deps.pools.ro.query<{ result: unknown; scanned_at: Date }>(
      'SELECT result, scanned_at FROM dataset_stats WHERE target_key = $1',
      [tk],
    )
    return c.json({
      job: jobR.rows[0] ?? null,
      stats: statsR.rows[0]?.result ?? null,
      scannedAt: statsR.rows[0]?.scanned_at?.toISOString() ?? null,
    })
  })

  app.post('/storage/:connId/media/scan-cancel', async c => {
    const body = (await c.req.json()) as { jobId?: number }
    if (body.jobId == null) return c.json({ error: 'jobId required' }, 400)
    await deps.pools.rw.query(
      `UPDATE media_jobs SET status = 'canceled', finished_at = now()
        WHERE id = $1 AND status IN ('queued','processing')`,
      [body.jobId],
    )
    return c.json({ ok: true })
  })
}
```

`api/internal.ts` に mount を追加（`mountStoragePreviewRoutes` の次の行）:

```ts
import { mountStorageMediaRoutes } from './routes/storage-media.js'
// …
mountStorageMediaRoutes(api, {
  getStorage: storageFactory.getStorage,
  pools,
  env,
})
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd api && npx vitest run routes/storage-media.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/routes/storage-media.ts api/routes/storage-media.test.ts api/internal.ts
git commit -m "feat: media API (analyze/spectrogram/scan) ルートを追加"
```

---

### Task 10: Dockerfile.worker + compose (dev/prod) + README

**Files:**
- Create: `api/Dockerfile.worker`
- Modify: `compose.dev.yaml`, `compose.prod.yaml`, `README.md`（環境変数表 + アーキテクチャ図）

**Interfaces:**
- Produces: `media-worker` サービス（dev: `tsx watch worker.ts` / prod: `node dist/worker.js`）。api-internal から `http://media-worker:3100` で到達可能

- [ ] **Step 1: Dockerfile.worker を書く**

`api/Dockerfile.worker`（既存 `api/Dockerfile` に ffmpeg を足しただけの派生。ベースを揃えて npm ci のキャッシュを共有）:

```dockerfile
# api/Dockerfile.worker — media-worker 用。api と同じコードベースに ffmpeg を追加。
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ bzip2 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chown -R node:node /app
USER node

EXPOSE 3100

CMD ["npx", "tsx", "worker.ts"]
```

- [ ] **Step 2: compose.dev.yaml に media-worker を追加**

`compose.dev.yaml` の `api-internal:` ブロックの後に:

```yaml
  media-worker:
    build:
      context: ./api
      dockerfile: Dockerfile.worker
    container_name: mado-dev-media-worker
    command: ["npx", "tsx", "watch", "worker.ts"]
    env_file:
      - .env
    volumes:
      - ./api:/app
      - /app/node_modules
    depends_on:
      postgres:
        condition: service_healthy
```

（ポートはホストに公開しない — api-internal からのみ compose ネットワーク内で到達）

- [ ] **Step 3: compose.prod.yaml に media-worker を追加**

`compose.prod.yaml` を開き、`api-internal` サービスの定義を確認する。同じ構造（env_file / restart / build 済み `dist` 実行）で `media-worker` サービスを追加する:

prod の api-internal は起動 command で `npm run build && node dist/internal.js` を実行する形式。media-worker も同じ形式で `compose.prod.yaml` の `api-internal:` ブロックの後に追加する:

```yaml
  media-worker:
    build:
      context: ./api
      dockerfile: Dockerfile.worker
    container_name: mado-prod-media-worker
    command: ["sh", "-c", "npm run build && node dist/worker.js"]
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
```

- [ ] **Step 4: 起動して疎通を確認**

```bash
docker compose -f compose.dev.yaml up -d --build media-worker
docker compose -f compose.dev.yaml exec media-worker node -e "fetch('http://localhost:3100/healthz').then(r=>r.text()).then(console.log)"
docker compose -f compose.dev.yaml exec api-internal node -e "fetch('http://media-worker:3100/healthz').then(r=>r.text()).then(console.log)"
```

Expected: どちらも `ok`

- [ ] **Step 5: README.md を更新**

- 環境変数の表に `MEDIA_CONCURRENCY` / `MEDIA_ANALYZE_TIMEOUT_SEC` / `MEDIA_SCAN_MAX_FILES` / `MEDIA_CACHE_MAX_AGE_DAYS` / `MEDIA_SPECTROGRAM_MAX_WIDTH`（いずれも必須: no、既定値は Global Constraints の値）を追記
- アーキテクチャ図とサービス表に `media-worker` 行を追加（dev: `tsx watch worker.ts` / prod: `node dist/worker.js`、ffmpeg 入り）
- 「できること」に波形/スペクトログラム・同期プレイヤー・データセットスキャンの 3 行を追加

- [ ] **Step 6: Commit**

```bash
git add api/Dockerfile.worker compose.dev.yaml compose.prod.yaml README.md
git commit -m "feat: media-worker コンテナを compose に追加"
```

---

### Task 11: front API クライアント + zod 型

**Files:**
- Modify: `front/lib/api/types.ts`, `front/lib/api/client.ts`
- Test: `front/lib/api/media-client.test.ts`（新規）

**Interfaces:**
- Produces（後続タスクが使う正確なシグネチャ）:
  - `types.ts`: `export const MediaAnalyze = z.object({ cacheKey: z.string(), peaks: z.array(z.tuple([z.number(), z.number()])), durationSec: z.number().nullable(), sampleRate: z.number().nullable(), hasSpectrogram: z.boolean() })`
  - `types.ts`: `export const ScanStatus = z.object({ job: z.object({ id: z.number(), status: z.enum(['queued','processing','done','error','canceled']), progress: z.object({ filesDone: z.number(), filesTotal: z.number(), currentKey: z.string() }).nullable(), error: z.string().nullable() }).nullable(), stats: z.record(z.string(), z.unknown()).nullable(), scannedAt: z.string().nullable() })`
  - `client.ts` の `api` オブジェクトに:
    - `mediaAnalyze: (connId: string, bucket: string, key: string, opts?: { entryPath?: string; signal?: AbortSignal }) => Promise<z.infer<typeof MediaAnalyze>>`（長時間かかりうる。キャッシュはサーバー側なのでフロント TTLCache には入れない）
    - `spectrogramUrl: (connId: string, cacheKey: string) => string`
    - `scanStart: (connId: string, body: { bucket: string; prefix?: string; tarKey?: string }) => Promise<{ jobId: number }>`
    - `scanStatus: (connId: string, bucket: string, target: { prefix?: string; tarKey?: string }) => Promise<z.infer<typeof ScanStatus>>`
    - `scanCancel: (connId: string, jobId: number) => Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`front/lib/api/media-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('media client', () => {
  it('mediaAnalyze: URL / signal / zod parse', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 2, sampleRate: 16000, hasSpectrogram: true,
    }))
    const ctl = new AbortController()
    const r = await api.mediaAnalyze('c 1', 'b', 'dir/a.wav', { signal: ctl.signal })
    expect(r.cacheKey).toBe('ck')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c%201/media/analyze?bucket=b&key=dir%2Fa.wav')
    expect((init as RequestInit).signal).toBe(ctl.signal)
  })

  it('mediaAnalyze: entryPath がクエリに乗る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false,
    }))
    await api.mediaAnalyze('c', 'b', 'shard.tar', { entryPath: 'u1.wav' })
    expect(String(spy.mock.calls[0][0])).toContain('entryPath=u1.wav')
  })

  it('spectrogramUrl を組み立てる', () => {
    expect(api.spectrogramUrl('c', 'ck')).toBe('/api/internal/storage/c/media/spectrogram?cacheKey=ck')
  })

  it('scanStart は POST、scanStatus は zod で検証', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 7 }), { status: 202 }))
      .mockResolvedValueOnce(okJson({ job: null, stats: null, scannedAt: null }))
    const started = await api.scanStart('c', { bucket: 'b', prefix: 'ds/' })
    expect(started.jobId).toBe(7)
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST')
    const st = await api.scanStatus('c', 'b', { prefix: 'ds/' })
    expect(st.job).toBeNull()
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run lib/api/media-client.test.ts`
Expected: FAIL（`api.mediaAnalyze` が存在しない）

- [ ] **Step 3: 実装**

`front/lib/api/types.ts` 末尾に追記:

```ts
// 音声解析 (波形 / スペクトログラム)。GET /storage/:connId/media/analyze
export const MediaAnalyze = z.object({
  cacheKey: z.string(),
  peaks: z.array(z.tuple([z.number(), z.number()])),
  durationSec: z.number().nullable(),
  sampleRate: z.number().nullable(),
  hasSpectrogram: z.boolean(),
})

// データセットスキャンの状態。GET /storage/:connId/media/scan-status
export const ScanStatus = z.object({
  job: z.object({
    id: z.number(),
    status: z.enum(['queued', 'processing', 'done', 'error', 'canceled']),
    progress: z.object({
      filesDone: z.number(),
      filesTotal: z.number(),
      currentKey: z.string(),
    }).nullable(),
    error: z.string().nullable(),
  }).nullable(),
  stats: z.record(z.string(), z.unknown()).nullable(),
  scannedAt: z.string().nullable(),
})
```

`front/lib/api/client.ts` — import に `MediaAnalyze, ScanStatus` を追加し、`api` オブジェクトに追記（`audioUrl` の近く）:

```ts
  // 音声解析 (波形ピーク + スペクトログラム有無)。サーバー側でキャッシュされる
  // ため TTLCache には入れない。長尺ファイルはレスポンスまで数十秒かかりうる —
  // 呼び出し側は AbortSignal でアンマウント時に中断すること。
  mediaAnalyze: async (
    connId: string,
    bucket: string,
    key: string,
    opts: { entryPath?: string; signal?: AbortSignal } = {},
  ) => {
    const url = buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/media/analyze`, {
      bucket, key, entryPath: opts.entryPath,
    })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) msg = body.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    return MediaAnalyze.parse(await res.json())
  },

  spectrogramUrl: (connId: string, cacheKey: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/media/spectrogram`, { cacheKey }),

  scanStart: (connId: string, body: { bucket: string; prefix?: string; tarKey?: string }) =>
    mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/media/scan`,
      { method: 'POST', body },
      z.object({ jobId: z.number() }),
    ),

  scanStatus: (connId: string, bucket: string, target: { prefix?: string; tarKey?: string }) =>
    getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/media/scan-status`, {
      bucket, prefix: target.prefix, tarKey: target.tarKey,
    }), ScanStatus),

  scanCancel: async (connId: string, jobId: number): Promise<void> => {
    await mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/media/scan-cancel`,
      { method: 'POST', body: { jobId } },
      z.object({ ok: z.boolean() }),
    )
  },
```

注意: `buildUrl` は空文字パラメータを落とすため、バケット直下 (`prefix: ''`) のスキャンで `prefix` が消えて API が 400 を返す。`scanStatus` は `buildUrl` を使わず明示的に組み立てること:

```ts
  scanStatus: (connId: string, bucket: string, target: { prefix?: string; tarKey?: string }) => {
    const search = new URLSearchParams({ bucket })
    if (target.tarKey != null) search.set('tarKey', target.tarKey)
    else search.set('prefix', target.prefix ?? '')
    return getJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/media/scan-status?${search.toString()}`,
      ScanStatus,
    )
  },
```

（上の `api` オブジェクト追記のうち `scanStatus` はこの形に差し替え。`scanStart` は POST の JSON body なので空文字がそのまま届く — 対応不要）

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run lib/api/media-client.test.ts && npx tsc -b --noEmit 2>/dev/null || npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add front/lib/api/types.ts front/lib/api/client.ts front/lib/api/media-client.test.ts
git commit -m "feat: front に media API クライアント (analyze/scan) を追加"
```

---

### Task 12: Waveform コンポーネント (canvas 描画 + クリックシーク)

**Files:**
- Create: `front/components/Waveform.tsx`
- Test: `front/components/Waveform.test.tsx`

**Interfaces:**
- Produces: `export function Waveform({ peaks, progress, onSeek, height }: { peaks: Array<[number, number]>; progress: number; onSeek?: (ratio: number) => void; height?: number }): JSX.Element`
  - `progress` は 0〜1（再生ヘッド位置）。描画は canvas、色は CSS 変数 `--color-ink-11`（再生済み）/ `--color-ink-6`（未再生）を `getComputedStyle` で解決（既存 Tailwind トークンに追従、無ければ `#444` / `#999` にフォールバック）
  - クリック位置 / 幅 = ratio を `onSeek` に渡す。`role="slider"` + `aria-label="再生位置"` を付ける
  - devicePixelRatio 対応（canvas 内部解像度を `clientWidth × dpr` に、ResizeObserver で追従）

- [ ] **Step 1: 失敗するテストを書く**

`front/components/Waveform.test.tsx`（jsdom には canvas 2D が無いので getContext をスタブ）:

```tsx
import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Waveform } from './Waveform'

beforeEach(() => {
  const ctx = {
    clearRect: vi.fn(), fillRect: vi.fn(), scale: vi.fn(),
    setTransform: vi.fn(), fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
})

describe('Waveform', () => {
  it('canvas を slider role で描画する', () => {
    const { getByRole } = render(
      <Waveform peaks={[[-1, 1], [-0.5, 0.5]]} progress={0} />,
    )
    expect(getByRole('slider', { name: '再生位置' })).toBeInTheDocument()
  })

  it('クリック位置の比率で onSeek が呼ばれる', () => {
    const onSeek = vi.fn()
    const { getByRole } = render(
      <Waveform peaks={[[-1, 1]]} progress={0} onSeek={onSeek} />,
    )
    const el = getByRole('slider')
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    )
    fireEvent.click(el, { clientX: 50 })
    expect(onSeek).toHaveBeenCalledWith(0.25)
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/Waveform.test.tsx`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`front/components/Waveform.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react'

interface Props {
  peaks: Array<[number, number]>
  // 0〜1 の再生位置。再生ヘッド線 + 再生済み領域の色分けに使う。
  progress: number
  onSeek?: (ratio: number) => void
  height?: number
}

// CSS 変数を解決する。テスト (jsdom) や変数未定義時はフォールバック。
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

export function Waveform({ peaks, progress, onSeek, height = 64 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = height
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (peaks.length === 0 || w === 0) return

    const played = cssVar(canvas, '--color-ink-11', '#444')
    const rest = cssVar(canvas, '--color-ink-6', '#999')
    const mid = h / 2
    const barW = w / peaks.length
    const playedX = progress * w
    for (let i = 0; i < peaks.length; i++) {
      const [mn, mx] = peaks[i]
      const x = i * barW
      // min/max は -1〜1。高さ 1px 未満でも点として見えるように clamp。
      const top = mid - mx * mid
      const bh = Math.max(1, (mx - mn) * mid)
      ctx.fillStyle = x <= playedX ? played : rest
      ctx.fillRect(x, top, Math.max(1, barW - 0.5), bh)
    }
    // 再生ヘッド線
    if (progress > 0) {
      ctx.fillStyle = played
      ctx.fillRect(playedX - 0.5, 0, 1, h)
    }
  }, [peaks, progress, height])

  useEffect(() => {
    draw()
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw])

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onSeek(ratio)
  }, [onSeek])

  return (
    <canvas
      ref={canvasRef}
      role="slider"
      aria-label="再生位置"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={onSeek ? 0 : -1}
      className="block w-full cursor-pointer"
      style={{ height }}
      onClick={handleClick}
    />
  )
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/Waveform.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add front/components/Waveform.tsx front/components/Waveform.test.tsx
git commit -m "feat: 波形 canvas コンポーネントを追加"
```

---

### Task 13: PreviewAudio 拡張 (波形 + スペクトログラム) と TarEntryModal 接続

**Files:**
- Modify: `front/components/PreviewAudio.tsx`, `front/components/TarEntryModal.tsx`
- Test: `front/components/PreviewAudio.test.tsx`（新規）

**Interfaces:**
- Consumes: `api.mediaAnalyze` / `api.spectrogramUrl` (Task 11), `Waveform` (Task 12), 既存 `api.audioUrl` / `api.tarEntryUrl`
- Produces: `export function PreviewAudio({ connId, bucket, k, entryPath }: { connId: string; bucket: string; k: string; entryPath?: string })`
  - `entryPath` があれば `<audio src>` は `api.tarEntryUrl(connId, bucket, k, entryPath)`、無ければ従来の `api.audioUrl`
  - マウント時に `mediaAnalyze` を実行（AbortController、アンマウントで abort）。取得中は「解析中…」、失敗は小さくメッセージ、成功で `Waveform` + （`hasSpectrogram` なら）スペクトログラムのトグルボタンを表示
  - 再生ヘッドは `requestAnimationFrame` で `audio.currentTime / duration` を `progress` に反映。`onSeek(ratio)` → `audio.currentTime = ratio * duration`
- `TarEntryModal.tsx` の `AudioBody`（`<audio src={url}>` のみ）を `PreviewAudio` 呼び出しに置換: `{kind === 'audio' && <PreviewAudio connId={connId} bucket={bucket} k={archiveKey} entryPath={entry.name} />}`（既存 props 名は TarEntryModal 内の実際の変数名に合わせる）

- [ ] **Step 1: 失敗するテストを書く**

`front/components/PreviewAudio.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewAudio } from './PreviewAudio'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      mediaAnalyze: vi.fn(),
    },
  }
})

afterEach(() => vi.clearAllMocks())

describe('PreviewAudio', () => {
  it('解析結果で波形が出る / スペクトログラムはトグル', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: true,
    })
    render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    expect(screen.getByText('解析中…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'スペクトログラムを表示' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'スペクトログラム' })).not.toBeInTheDocument()
  })

  it('解析失敗は小さくエラー表示、再生 UI は残る', async () => {
    vi.mocked(api.mediaAnalyze).mockRejectedValue(new Error('解析できませんでした'))
    const { container } = render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByText(/解析できませんでした/)).toBeInTheDocument())
    expect(container.querySelector('audio')).not.toBeNull()
  })

  it('entryPath があれば tar-entry URL を audio src に使い、analyze にも渡す', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false,
    })
    const { container } = render(
      <PreviewAudio connId="c" bucket="b" k="shard.tar" entryPath="u1.wav" />,
    )
    const audio = container.querySelector('audio')!
    expect(audio.src).toContain('/preview/tar-entry')
    expect(audio.src).toContain('entry=u1.wav')
    await waitFor(() => expect(api.mediaAnalyze).toHaveBeenCalledWith(
      'c', 'b', 'shard.tar', expect.objectContaining({ entryPath: 'u1.wav' }),
    ))
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/PreviewAudio.test.tsx`
Expected: FAIL（`解析中…` が無い等）

- [ ] **Step 3: PreviewAudio を実装**

`front/components/PreviewAudio.tsx` を全面書き換え:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { MediaAnalyze } from '../lib/api/types'
import { Waveform } from './Waveform'

type Analyze = z.infer<typeof MediaAnalyze>

interface Props {
  connId: string
  bucket: string
  k: string
  // tar 内エントリのとき: k = tar のキー、entryPath = tar 内パス
  entryPath?: string
}

export function PreviewAudio({ connId, bucket, k, entryPath }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [analyze, setAnalyze] = useState<Analyze | null>(null)
  const [analyzing, setAnalyzing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [showSpec, setShowSpec] = useState(false)

  const src = entryPath
    ? api.tarEntryUrl(connId, bucket, k, entryPath)
    : api.audioUrl(connId, bucket, k)

  // 解析はサーバー側キャッシュがあるので毎マウントで呼んでよい。
  // 長尺はレスポンスまで時間がかかる — アンマウントで abort して ffmpeg を止める。
  useEffect(() => {
    const ctl = new AbortController()
    setAnalyzing(true)
    setError(null)
    setAnalyze(null)
    api.mediaAnalyze(connId, bucket, k, { entryPath, signal: ctl.signal })
      .then(r => setAnalyze(r))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError((e as Error).message)
      })
      .finally(() => setAnalyzing(false))
    return () => ctl.abort()
  }, [connId, bucket, k, entryPath])

  // 再生ヘッド追従 (rAF)。timeupdate はイベント間隔が粗く波形上でカクつく。
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const a = audioRef.current
      if (a && a.duration > 0) setProgress(a.currentTime / a.duration)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onSeek = (ratio: number): void => {
    const a = audioRef.current
    if (a && Number.isFinite(a.duration)) a.currentTime = ratio * a.duration
  }

  return (
    <div className="flex flex-col gap-2">
      <audio ref={audioRef} className="w-full" src={src} controls preload="metadata" />
      {analyzing && <p className="m-0 text-[12px] text-ink-7">解析中…</p>}
      {error && <p className="m-0 text-[12px] text-ink-7">波形を表示できません: {error}</p>}
      {analyze && analyze.peaks.length > 0 && (
        <Waveform peaks={analyze.peaks} progress={progress} onSeek={onSeek} />
      )}
      {analyze?.hasSpectrogram && (
        <div>
          <button
            type="button"
            className="ghost text-[11px]"
            onClick={() => setShowSpec(s => !s)}
          >
            {showSpec ? 'スペクトログラムを隠す' : 'スペクトログラムを表示'}
          </button>
          {showSpec && (
            <img
              className="mt-1 w-full"
              src={api.spectrogramUrl(connId, analyze.cacheKey)}
              alt="スペクトログラム"
            />
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: TarEntryModal を接続する**

`front/components/TarEntryModal.tsx`:
- `AudioBody` 関数を削除し、audio 分岐（83 行目付近 `{kind === 'audio' && <AudioBody url={url} />}`）を以下に置換（`connId` / `bucket` / `archiveKey` / `entry` は同ファイル内の実際の props / 変数名を確認して合わせる）:

```tsx
{kind === 'audio' && (
  <PreviewAudio connId={connId} bucket={bucket} k={archiveKey} entryPath={entry.name} />
)}
```

- import に `import { PreviewAudio } from './PreviewAudio'` を追加

- [ ] **Step 5: テストが通ることを確認**

Run: `cd front && npx vitest run components/PreviewAudio.test.tsx && npm test`
Expected: PASS（TarEntryModal の既存テストも壊れていないこと。壊れたら audio 分岐のモック/期待値を追随修正）

- [ ] **Step 6: Commit**

```bash
git add front/components/PreviewAudio.tsx front/components/PreviewAudio.test.tsx front/components/TarEntryModal.tsx
git commit -m "feat: 音声プレビューに波形とスペクトログラム表示を追加"
```

---

### Task 14: 同期マルチトラックプレイヤー (PlayerDeck)

**Files:**
- Create: `front/lib/driftSync.ts`, `front/lib/playerDeck.tsx`, `front/components/PlayerDeck.tsx`
- Modify: `front/App.tsx`
- Test: `front/lib/driftSync.test.ts`, `front/components/PlayerDeck.test.tsx`

**Interfaces:**
- Produces:
  - `driftSync.ts`: `export function computeDriftAdjustments(masterSec: number, trackSecs: Array<number | null>, thresholdSec?: number): Array<{ index: number; to: number }>`（null = 終了済み/未ロードのトラックはスキップ。既定 threshold 0.05）
  - `playerDeck.tsx`:
    - `export interface DeckTrack { id: string; label: string; src: string; connId: string; bucket: string; key: string; entryPath?: string }`
    - `export function PlayerDeckProvider({ children }: { children: ReactNode }): JSX.Element`
    - `export function usePlayerDeck(): { tracks: DeckTrack[]; addTrack(t: Omit<DeckTrack, 'id'>): void; removeTrack(id: string): void; clear(): void }`
    - `addTrack` は同じ (connId,bucket,key,entryPath) の重複追加を無視する。`id` は `` `${connId}|${bucket}|${key}|${entryPath ?? ''}` ``
  - `PlayerDeck.tsx`: `export function PlayerDeck(): JSX.Element | null` — トラック 0 件なら null。画面下部固定 (`fixed inset-x-0 bottom-0`)。トラックごとに `<audio>`（非表示 controls なし）+ ラベル + M(ミュート)/S(ソロ)/✕(削除)。マスター操作: ▶/⏸(全トラック同時 play/pause)、■(停止 = 全 currentTime 0 + pause)、シークバー(`<input type="range">`、全トラックの currentTime を一斉変更)、時刻表示。1 秒ごとに `computeDriftAdjustments` でずれたトラックを合わせ直す
- App.tsx: `<PlayerDeckProvider>` で全体を包み、`</main>` の直後に `<PlayerDeck />` を置く

- [ ] **Step 1: driftSync の失敗するテストを書く**

`front/lib/driftSync.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeDriftAdjustments } from './driftSync'

describe('computeDriftAdjustments', () => {
  it('threshold 以上ずれたトラックだけ矯正する', () => {
    expect(computeDriftAdjustments(10, [10.02, 10.2, 9.7])).toEqual([
      { index: 1, to: 10 },
      { index: 2, to: 10 },
    ])
  })
  it('null (終了済み) はスキップ', () => {
    expect(computeDriftAdjustments(10, [null, 12])).toEqual([{ index: 1, to: 10 }])
  })
  it('threshold は指定できる', () => {
    expect(computeDriftAdjustments(10, [10.2], 0.5)).toEqual([])
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run lib/driftSync.test.ts`
Expected: FAIL

- [ ] **Step 3: driftSync を実装**

`front/lib/driftSync.ts`:

```ts
// 同期デッキのドリフト補正。<audio> を複数同時 play() してもクロックは
// 徐々にずれるので、1 秒ごとにマスター時刻へ引き戻す対象を計算する。
// サンプル精度ではない (数十 ms) — チャンネル聴き比べ用途には十分。
export function computeDriftAdjustments(
  masterSec: number,
  trackSecs: Array<number | null>,
  thresholdSec = 0.05,
): Array<{ index: number; to: number }> {
  const out: Array<{ index: number; to: number }> = []
  trackSecs.forEach((t, index) => {
    if (t == null) return
    if (Math.abs(t - masterSec) >= thresholdSec) out.push({ index, to: masterSec })
  })
  return out
}
```

Run: `cd front && npx vitest run lib/driftSync.test.ts` → PASS

- [ ] **Step 4: PlayerDeck の失敗するテストを書く**

`front/components/PlayerDeck.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../lib/playerDeck'
import { PlayerDeck } from './PlayerDeck'

// jsdom の HTMLMediaElement は play/pause 未実装
beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})

function AddButton({ n }: { n: number }) {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({
      label: `ch${n}`, src: `/audio/ch${n}.wav`, connId: 'c', bucket: 'b', key: `ch${n}.wav`,
    })}>
      add{n}
    </button>
  )
}

function setup() {
  return render(
    <PlayerDeckProvider>
      <AddButton n={1} />
      <AddButton n={2} />
      <PlayerDeck />
    </PlayerDeckProvider>,
  )
}

describe('PlayerDeck', () => {
  it('トラック 0 件では描画されない', () => {
    setup()
    expect(screen.queryByText('同期プレイヤー')).not.toBeInTheDocument()
  })

  it('追加でトラック行が出る / 重複追加は無視', () => {
    setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(screen.getByText(/同期プレイヤー/)).toBeInTheDocument()
    expect(screen.getAllByText('ch1')).toHaveLength(1)
    expect(screen.getByText('ch2')).toBeInTheDocument()
  })

  it('一括再生で全 <audio> の play が呼ばれる', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    fireEvent.click(screen.getByRole('button', { name: '一括再生' }))
    const audios = container.querySelectorAll('audio')
    expect(audios).toHaveLength(2)
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  })

  it('ソロは他トラックをミュートする', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    fireEvent.click(screen.getAllByRole('button', { name: 'ソロ' })[0])
    const audios = [...container.querySelectorAll('audio')]
    expect(audios[0].muted).toBe(false)
    expect(audios[1].muted).toBe(true)
  })
})
```

- [ ] **Step 5: 失敗を確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 6: playerDeck.tsx (Context) を実装**

`front/lib/playerDeck.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface DeckTrack {
  id: string
  label: string
  src: string
  connId: string
  bucket: string
  key: string
  entryPath?: string
}

interface PlayerDeckApi {
  tracks: DeckTrack[]
  addTrack(t: Omit<DeckTrack, 'id'>): void
  removeTrack(id: string): void
  clear(): void
}

const Ctx = createContext<PlayerDeckApi | null>(null)

// ルーティングの外側 (App) に置く。Storage 内のページ遷移でもデッキは消えない。
// リロードでは消える (v1 では永続化しない)。
export function PlayerDeckProvider({ children }: { children: ReactNode }) {
  const [tracks, setTracks] = useState<DeckTrack[]>([])
  const addTrack = useCallback((t: Omit<DeckTrack, 'id'>) => {
    const id = [t.connId, t.bucket, t.key, t.entryPath ?? ''].join('|')
    setTracks(cur => (cur.some(x => x.id === id) ? cur : [...cur, { ...t, id }]))
  }, [])
  const removeTrack = useCallback((id: string) => {
    setTracks(cur => cur.filter(t => t.id !== id))
  }, [])
  const clear = useCallback(() => setTracks([]), [])
  const api = useMemo(() => ({ tracks, addTrack, removeTrack, clear }), [tracks, addTrack, removeTrack, clear])
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function usePlayerDeck(): PlayerDeckApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlayerDeck must be used within PlayerDeckProvider')
  return ctx
}
```

- [ ] **Step 7: PlayerDeck.tsx (ドック UI) を実装**

`front/components/PlayerDeck.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { computeDriftAdjustments } from '../lib/driftSync'
import { usePlayerDeck } from '../lib/playerDeck'
import { Waveform } from './Waveform'
import { api } from '../lib/api/client'

// マルチチャンネル録音のチャンネル別ファイルを頭出しを揃えて同時再生する
// 画面下部ドック。<audio> ベース + 1 秒ごとのドリフト補正 (サンプル精度ではない)。
export function PlayerDeck() {
  const { tracks, removeTrack, clear } = usePlayerDeck()
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const [playing, setPlaying] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [masterTime, setMasterTime] = useState(0)
  const [soloId, setSoloId] = useState<string | null>(null)
  const [muted, setMuted] = useState<Set<string>>(new Set())
  const [peaksById, setPeaksById] = useState<Record<string, Array<[number, number]>>>({})

  const audios = useCallback(
    () => tracks.map(t => audioRefs.current.get(t.id)).filter((a): a is HTMLAudioElement => a != null),
    [tracks],
  )

  // マスター時刻 = 最初のトラックの currentTime。1 秒ごとにドリフト補正。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const list = audios()
      const master = list[0]
      if (!master) return
      setMasterTime(master.currentTime)
      const secs = list.map(a => (a.ended ? null : a.currentTime))
      for (const adj of computeDriftAdjustments(master.currentTime, secs)) {
        list[adj.index].currentTime = adj.to
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, audios])

  // ミュート / ソロを <audio> に反映
  useEffect(() => {
    for (const t of tracks) {
      const a = audioRefs.current.get(t.id)
      if (!a) continue
      a.muted = soloId != null ? t.id !== soloId : muted.has(t.id)
    }
  }, [tracks, soloId, muted])

  // 各トラックの波形 (キャッシュ済みが多い想定)。失敗は静かに無視。
  useEffect(() => {
    for (const t of tracks) {
      if (peaksById[t.id]) continue
      api.mediaAnalyze(t.connId, t.bucket, t.key, { entryPath: t.entryPath })
        .then(r => setPeaksById(cur => ({ ...cur, [t.id]: r.peaks })))
        .catch(() => { /* デッキでは波形なしで続行 */ })
    }
  }, [tracks, peaksById])

  if (tracks.length === 0) return null

  const playAll = (): void => {
    for (const a of audios()) void a.play()
    setPlaying(true)
  }
  const pauseAll = (): void => {
    for (const a of audios()) a.pause()
    setPlaying(false)
  }
  const stopAll = (): void => {
    for (const a of audios()) {
      a.pause()
      a.currentTime = 0
    }
    setPlaying(false)
    setMasterTime(0)
  }
  const seekAll = (sec: number): void => {
    for (const a of audios()) a.currentTime = sec
    setMasterTime(sec)
  }
  const maxDuration = Math.max(0, ...audios().map(a => (Number.isFinite(a.duration) ? a.duration : 0)))
  const fmt = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 backdrop-blur dark:bg-neutral-900/95"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div className="mx-auto max-w-[1180px] px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <button type="button" className="ghost text-[11px]" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? '▲' : '▼'} 同期プレイヤー ({tracks.length})
          </button>
          <div className="flex-1" />
          <button type="button" className="ghost text-[11px]" onClick={() => { stopAll(); clear() }}>
            クリア
          </button>
        </div>
        {!collapsed && (
          <>
            <ul className="m-0 max-h-48 list-none overflow-y-auto p-0">
              {tracks.map(t => (
                <li key={t.id} className="flex items-center gap-2 py-1" style={{ borderTop: '1px solid var(--rule)' }}>
                  <span className="w-40 truncate text-[12px] text-ink-11" title={t.label}>{t.label}</span>
                  <div className="min-w-0 flex-1">
                    <Waveform
                      peaks={peaksById[t.id] ?? []}
                      progress={maxDuration > 0 ? masterTime / maxDuration : 0}
                      height={28}
                    />
                  </div>
                  <audio
                    ref={el => {
                      if (el) audioRefs.current.set(t.id, el)
                      else audioRefs.current.delete(t.id)
                    }}
                    src={t.src}
                    preload="metadata"
                  />
                  <button
                    type="button"
                    className={`ghost text-[11px] ${muted.has(t.id) ? 'opacity-40' : ''}`}
                    aria-label="ミュート"
                    onClick={() => setMuted(cur => {
                      const next = new Set(cur)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      return next
                    })}
                  >M</button>
                  <button
                    type="button"
                    className={`ghost text-[11px] ${soloId === t.id ? 'font-bold' : ''}`}
                    aria-label="ソロ"
                    onClick={() => setSoloId(cur => (cur === t.id ? null : t.id))}
                  >S</button>
                  <button type="button" className="ghost text-[11px]" aria-label="削除" onClick={() => removeTrack(t.id)}>✕</button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 pt-1" style={{ borderTop: '1px solid var(--rule)' }}>
              {playing ? (
                <button type="button" className="ghost" aria-label="一時停止" onClick={pauseAll}>⏸</button>
              ) : (
                <button type="button" className="ghost" aria-label="一括再生" onClick={playAll}>▶</button>
              )}
              <button type="button" className="ghost" aria-label="停止" onClick={stopAll}>■</button>
              <span className="text-[11px] tabular-nums text-ink-7">{fmt(masterTime)} / {fmt(maxDuration)}</span>
              <input
                type="range"
                className="flex-1"
                min={0}
                max={maxDuration || 0}
                step={0.1}
                value={masterTime}
                aria-label="マスターシーク"
                onChange={e => seekAll(Number(e.target.value))}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 8: App.tsx に配線する**

`front/App.tsx`:
- import 追加: `import { PlayerDeckProvider } from './lib/playerDeck'` / `import { PlayerDeck } from './components/PlayerDeck'`
- `App` の return 全体を `<PlayerDeckProvider>…</PlayerDeckProvider>` で包み、`</main>` の直後（`</div>` の前）に `<PlayerDeck />` を追加

- [ ] **Step 9: テストが通ることを確認**

Run: `cd front && npx vitest run components/PlayerDeck.test.tsx && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add front/lib/driftSync.ts front/lib/driftSync.test.ts front/lib/playerDeck.tsx front/components/PlayerDeck.tsx front/components/PlayerDeck.test.tsx front/App.tsx
git commit -m "feat: 同期マルチトラックプレイヤー (画面下部ドック) を追加"
```

---

### Task 15: 「デッキに追加」アクション (一覧 + tar エントリ)

**Files:**
- Modify: `front/components/CopyMenu.tsx`（`MenuItem` に `action` kind を追加）, `front/components/storage/EntryTable.tsx`, `front/components/PreviewArchive.tsx`
- Test: `front/components/storage/EntryTable.deck.test.tsx`（新規）

**Interfaces:**
- Consumes: `usePlayerDeck` (Task 14), `classify` (`front/lib/api/mime.ts`), `api.audioUrl` / `api.tarEntryUrl`
- Produces:
  - `CopyMenu.tsx`: `MenuItem` union に `| { kind: 'action'; label: string; onSelect: () => void }` を追加。メニュー内で選択されたら `onSelect()` を呼んで閉じる（`copy` 分岐の実装を参考に、クリップボード操作の代わりに `onSelect` を呼ぶだけ）
  - `EntryTable.tsx`: `FileRow` / `FileCard` で `classify(f.key) === 'audio'` のとき items 先頭に `{ kind: 'action', label: 'デッキに追加', onSelect: () => deck.addTrack({ label: filename, src: api.audioUrl(connId, bucket, f.key), connId, bucket, key: f.key }) }` を追加（`const deck = usePlayerDeck()` を各 Row コンポーネントで呼ぶ）
  - `PreviewArchive.tsx`: エントリ一覧の音声エントリ行（`onClick={() => setOpenedEntry(e)}` の行）の横に「+デッキ」小ボタンを追加: `deck.addTrack({ label: e.name, src: api.tarEntryUrl(connId, bucket, k, e.name), connId, bucket, key: k, entryPath: e.name })`（クリックが行の onClick に伝播しないよう `e.stopPropagation()`）

- [ ] **Step 1: 失敗するテストを書く**

`front/components/storage/EntryTable.deck.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../../lib/playerDeck'
import { EntryTable } from './EntryTable'

function DeckSpy() {
  const { tracks } = usePlayerDeck()
  return <output data-testid="count">{tracks.length}</output>
}

function setup(files: Array<{ key: string; size: number }>) {
  return render(
    <MemoryRouter>
      <PlayerDeckProvider>
        <EntryTable
          dirs={[]}
          files={files.map(f => ({ ...f, lastModified: null }))}
          prefix=""
          connId="c"
          bucket="b"
        />
        <DeckSpy />
      </PlayerDeckProvider>
    </MemoryRouter>,
  )
}

describe('EntryTable デッキ追加', () => {
  it('音声ファイルの ⋯ メニューに「デッキに追加」が出て、選ぶとデッキに積まれる', () => {
    setup([{ key: 'ch1.wav', size: 10 }])
    // CopyMenu のトリガーを開く (既存 CopyMenu.test.tsx のセレクタに合わせる)
    fireEvent.click(screen.getByRole('button', { name: /メニュー|⋯/ }))
    fireEvent.click(screen.getByText('デッキに追加'))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('非音声ファイルには出ない', () => {
    setup([{ key: 'a.txt', size: 10 }])
    fireEvent.click(screen.getByRole('button', { name: /メニュー|⋯/ }))
    expect(screen.queryByText('デッキに追加')).not.toBeInTheDocument()
  })
})
```

注意: `files` の zod 型 (`StorageList`) のフィールド名 (`lastModified` 等) と CopyMenu トリガーの aria-label は既存テスト（`EntryTable.test.tsx` / `CopyMenu.test.tsx`）を開いて正確に合わせること。

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/storage/EntryTable.deck.test.tsx`
Expected: FAIL

- [ ] **Step 3: CopyMenu / EntryTable / PreviewArchive を実装**

- `CopyMenu.tsx`: `MenuItem` union に `{ kind: 'action'; label: string; onSelect: () => void }` を追加。メニュー項目レンダリングの分岐（`it.kind === 'download'` を参照）に `action` 分岐を追加し、クリックで `it.onSelect()` → メニューを閉じる
- `EntryTable.tsx`: 冒頭に `import { usePlayerDeck } from '../../lib/playerDeck'` / `import { classify } from '../../lib/api/mime'`。`FileRow` と `FileCard` それぞれで:

```tsx
const deck = usePlayerDeck()
const isAudio = classify(f.key) === 'audio'
const items = useMemo<MenuItem[]>(() => [
  ...(isAudio ? [{
    kind: 'action' as const,
    label: 'デッキに追加',
    onSelect: () => deck.addTrack({
      label: filename, src: api.audioUrl(connId, bucket, f.key),
      connId, bucket, key: f.key,
    }),
  }] : []),
  { kind: 'download', label: 'このファイルをダウンロード', href: downloadUrl, filename },
  { kind: 'copy',     label: 'Web URL をコピー',           value: webUrl },
  { kind: 'copy',     label: 'S3 URL をコピー',            value: s3Url },
], [isAudio, deck, connId, bucket, f.key, downloadUrl, webUrl, s3Url, filename])
```

- `PreviewArchive.tsx`: `import { usePlayerDeck } from '../lib/playerDeck'` / `import { classify } from '../lib/api/mime'`。エントリ行の JSX（`onClick={() => setOpenedEntry(e)}` 付近）で、`classify(e.name) === 'audio'` のとき行末に:

```tsx
<button
  type="button"
  className="ghost text-[11px]"
  title="デッキに追加"
  aria-label={`${e.name} をデッキに追加`}
  onClick={ev => {
    ev.stopPropagation()
    deck.addTrack({
      label: e.name,
      src: api.tarEntryUrl(connId, bucket, k, e.name),
      connId, bucket, key: k, entryPath: e.name,
    })
  }}
>+デッキ</button>
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd front && npx vitest run components/storage/EntryTable.deck.test.tsx && npm test`
Expected: PASS（EntryTable / CopyMenu / PreviewArchive の既存テストも全部通ること。`usePlayerDeck` が Provider 必須のため既存テストが落ちる場合は、`usePlayerDeck` を「Provider が無ければ no-op API を返す」形に変える — `useContext` が null なら `{ tracks: [], addTrack: () => {}, removeTrack: () => {}, clear: () => {} }` を返し、throw をやめる。その場合 Task 14 の throw テストも削除）

- [ ] **Step 5: Commit**

```bash
git add front/components/CopyMenu.tsx front/components/storage/EntryTable.tsx front/components/storage/EntryTable.deck.test.tsx front/components/PreviewArchive.tsx front/lib/playerDeck.tsx
git commit -m "feat: 一覧と tar エントリに「デッキに追加」アクションを追加"
```

---

### Task 16: データセット統計パネル (スキャン UI)

**Files:**
- Create: `front/components/DatasetStatsPanel.tsx`
- Modify: `front/components/StorageBrowser.tsx`（ディレクトリビューに設置）, `front/components/PreviewArchive.tsx`（tar ヘッダに設置）
- Test: `front/components/DatasetStatsPanel.test.tsx`

**Interfaces:**
- Consumes: `api.scanStart` / `api.scanStatus` / `api.scanCancel` (Task 11)
- Produces: `export function DatasetStatsPanel({ connId, bucket, target }: { connId: string; bucket: string; target: { prefix?: string; tarKey?: string } }): JSX.Element`
  - 折りたたみ（`<details>`）: summary は「データセット統計」。開いたときに `scanStatus` を取得
  - 状態別表示: stats なし & job なし →「スキャンを実行」ボタン / job queued・processing → 進捗（`filesDone / filesTotal`、filesTotal=-1 は「n ファイル処理済み」表示）+「キャンセル」/ done or stats あり → サマリ（総時間 h:mm, ファイル数, テキスト数, 語彙, 文字種）+ duration ヒストグラム（CSS バー）+ 頻出語上位 10 +「再スキャン」
  - job が queued/processing の間だけ 1 秒ポーリング（`setInterval` + アンマウントで解除）
  - 総時間の表示: `Math.floor(totalDurationSec/3600)h ` + 分。ヒストグラムのバーは `count / maxCount` 比で `width%` を計算した div

- [ ] **Step 1: 失敗するテストを書く**

`front/components/DatasetStatsPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatasetStatsPanel } from './DatasetStatsPanel'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return { api: { ...mod.api, scanStatus: vi.fn(), scanStart: vi.fn(), scanCancel: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const openPanel = () => fireEvent.click(screen.getByText('データセット統計'))

describe('DatasetStatsPanel', () => {
  it('未スキャン: 実行ボタン → scanStart が呼ばれる', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({ job: null, stats: null, scannedAt: null })
    vi.mocked(api.scanStart).mockResolvedValue({ jobId: 1 })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    const btn = await screen.findByRole('button', { name: 'スキャンを実行' })
    fireEvent.click(btn)
    await waitFor(() => expect(api.scanStart).toHaveBeenCalledWith('c', { bucket: 'b', prefix: 'ds/' }))
  })

  it('実行中: 進捗とキャンセルが出る', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({
      job: { id: 1, status: 'processing', progress: { filesDone: 3, filesTotal: 10, currentKey: 'x' }, error: null },
      stats: null, scannedAt: null,
    })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    expect(await screen.findByText(/3 \/ 10/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(api.scanCancel).toHaveBeenCalledWith('c', 1))
  })

  it('完了: サマリとヒストグラムが出る', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({
      job: null,
      stats: {
        fileCount: 100, totalDurationSec: 7260, textFileCount: 100,
        vocabSize: 500, vocabTruncated: false, charSet: 40,
        durationHistogram: [{ le: 1, count: 10 }, { le: null, count: 5 }],
        sampleRates: { '16000': 100 }, topWords: [['の', 30]], truncated: false,
      },
      scannedAt: '2026-07-07T00:00:00Z',
    })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    expect(await screen.findByText(/2h 1m/)).toBeInTheDocument()
    expect(screen.getByText(/100 ファイル/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再スキャン' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd front && npx vitest run components/DatasetStatsPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装**

`front/components/DatasetStatsPanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import type { ScanStatus } from '../lib/api/types'

type Status = z.infer<typeof ScanStatus>

interface Props {
  connId: string
  bucket: string
  target: { prefix?: string; tarKey?: string }
}

interface StatsShape {
  fileCount: number
  totalDurationSec: number
  durationHistogram: Array<{ le: number | null; count: number }>
  textFileCount: number
  vocabSize: number
  vocabTruncated: boolean
  charSet: number
  topWords: Array<[string, number]>
  truncated: boolean
}

const fmtDuration = (sec: number): string => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`
}

export function DatasetStatsPanel({ connId, bucket, target }: Props) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.scanStatus(connId, bucket, target))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
    // target はオブジェクトなので中身で依存させる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, target.prefix, target.tarKey])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // 実行中だけ 1 秒ポーリング
  const running = status?.job != null
    && (status.job.status === 'queued' || status.job.status === 'processing')
  useEffect(() => {
    if (!open || !running) return
    timerRef.current = setInterval(() => void refresh(), 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [open, running, refresh])

  const start = async (): Promise<void> => {
    await api.scanStart(connId, { bucket, ...target })
    await refresh()
  }
  const cancel = async (): Promise<void> => {
    if (status?.job) {
      await api.scanCancel(connId, status.job.id)
      await refresh()
    }
  }

  const stats = status?.stats as unknown as StatsShape | null
  const maxCount = stats ? Math.max(1, ...stats.durationHistogram.map(b => b.count)) : 1

  return (
    <details
      className="mb-3 text-[13px]"
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-7">
        データセット統計
      </summary>
      <div className="mt-2 flex flex-col gap-2 pl-1">
        {error && <p className="m-0 text-ink-7">{error}</p>}
        {status && !running && !stats && (
          <button type="button" className="ghost self-start" onClick={() => void start()}>
            スキャンを実行
          </button>
        )}
        {status?.job?.status === 'error' && (
          <p className="m-0 text-ink-7">前回のスキャンが失敗しました: {status.job.error}</p>
        )}
        {running && (
          <div className="flex items-center gap-3">
            <span className="text-ink-7">
              {status!.job!.status === 'queued'
                ? 'キュー待ち…'
                : status!.job!.progress
                  ? status!.job!.progress.filesTotal >= 0
                    ? `解析中… ${status!.job!.progress.filesDone} / ${status!.job!.progress.filesTotal}`
                    : `解析中… ${status!.job!.progress.filesDone} ファイル処理済み`
                  : '解析中…'}
            </span>
            <button type="button" className="ghost text-[11px]" onClick={() => void cancel()}>
              キャンセル
            </button>
          </div>
        )}
        {stats && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-ink-11">
              {fmtDuration(stats.totalDurationSec)}・{stats.fileCount} ファイル・
              テキスト {stats.textFileCount}・語彙 {stats.vocabSize}{stats.vocabTruncated ? '+' : ''}・
              文字種 {stats.charSet}
              {stats.truncated && <span className="text-ink-7">（上限で打ち切り）</span>}
            </p>
            <div className="flex flex-col gap-0.5">
              {stats.durationHistogram.map(b => (
                <div key={String(b.le)} className="flex items-center gap-2">
                  <span className="w-14 text-right text-[11px] tabular-nums text-ink-7">
                    {b.le != null ? `≤${b.le}s` : '60s+'}
                  </span>
                  <div className="h-3 flex-1">
                    <div
                      className="h-full bg-ink-6"
                      style={{ width: `${(b.count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-[11px] tabular-nums text-ink-7">{b.count}</span>
                </div>
              ))}
            </div>
            {stats.topWords.length > 0 && (
              <p className="m-0 text-[12px] text-ink-7">
                頻出語: {stats.topWords.slice(0, 10).map(([w, n]) => `${w} (${n})`).join(', ')}
              </p>
            )}
            <button type="button" className="ghost self-start text-[11px]" onClick={() => void start()}>
              再スキャン
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
```

- [ ] **Step 4: 設置する**

- `StorageBrowser.tsx`: `<EntryTable` を描画している箇所を見つけ、その直前に `<DatasetStatsPanel connId={connId} bucket={bucket} target={{ prefix }} />` を追加（`connId` / `bucket` / `prefix` は同スコープの実変数名に合わせる）。import を追加
- `PreviewArchive.tsx`: エントリ一覧の上（ページャ / ヘッダ付近）に `<DatasetStatsPanel connId={connId} bucket={bucket} target={{ tarKey: k }} />` を追加

- [ ] **Step 5: テストが通ることを確認**

Run: `cd front && npx vitest run components/DatasetStatsPanel.test.tsx && npm test && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add front/components/DatasetStatsPanel.tsx front/components/DatasetStatsPanel.test.tsx front/components/StorageBrowser.tsx front/components/PreviewArchive.tsx
git commit -m "feat: データセット統計パネル (スキャン UI) を追加"
```

---

### Task 17: 統合確認 (E2E 手動 + 全テスト)

**Files:**
- なし（確認のみ。問題があれば該当タスクに戻って修正）

- [ ] **Step 1: 全体を起動する**

```bash
docker compose -f compose.dev.yaml up -d --build
docker compose -f compose.dev.yaml ps
```

Expected: `postgres` / `api-internal` / `media-worker` / `front` が全て Up

- [ ] **Step 2: 全テスト + lint**

```bash
cd api && npm test && npm run lint && cd ..
cd front && npm test && npm run lint && cd ..
```

Expected: 全て PASS

- [ ] **Step 3: ブラウザで手動確認（http://localhost:5173）**

確認項目（S3 接続と音声ファイルがある前提。無ければ MinIO 等をローカルに立てて wav をアップロード）:

1. 音声ファイルのプレビュー → 波形が出る → クリックでシーク、再生ヘッドが追従
2. スペクトログラムのトグル表示
3. 同じファイルを開き直す → 即表示（キャッシュ命中）
4. tar (WebDataset) のエントリの音声 → 波形が出る
5. 一覧の ⋯ メニュー「デッキに追加」×2〜3 → 下部ドックに積まれる → 一括再生で頭出しが揃う → M/S/✕ が効く → ディレクトリを移動してもデッキが残る
6. ディレクトリの「データセット統計」→ スキャンを実行 → 進捗 → 完了で統計表示。実行中にキャンセルが効くことも確認
7. プレビューを開いてすぐ閉じる → `docker compose -f compose.dev.yaml logs media-worker` で ffmpeg がエラーなく中断されている

- [ ] **Step 4: スペックとの突き合わせ**

`docs/superpowers/specs/2026-07-07-audio-waveform-spectrogram-design.md` の「目的」「エラーハンドリング」の各行を読み、上の手動確認でカバーされていない項目があれば確認する。

- [ ] **Step 5: 完了報告**

superpowers:verification-before-completion スキルに従い、テスト出力を確認した上で完了を報告する。
