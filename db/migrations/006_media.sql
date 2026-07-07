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
