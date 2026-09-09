-- バケット全体走査の結果を時系列として保存する。
-- 追跡対象は明示的に有効化したものだけ。migration 適用だけでは走査を開始しない。

CREATE TABLE IF NOT EXISTS storage_capacity_targets (
  connection_id       TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket              TEXT        NOT NULL,
  enabled             BOOLEAN     NOT NULL DEFAULT true,
  interval_seconds    INTEGER     NOT NULL DEFAULT 86400
    CHECK (interval_seconds BETWEEN 21600 AND 604800),
  next_run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_job_id         INTEGER     REFERENCES jobs(id) ON DELETE SET NULL,
  last_attempt_at     TIMESTAMPTZ,
  last_success_at     TIMESTAMPTZ,
  last_status         TEXT        NOT NULL DEFAULT 'waiting'
    CHECK (last_status IN ('waiting', 'queued', 'success', 'partial', 'error', 'paused')),
  last_error          TEXT,
  consecutive_failures INTEGER    NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, bucket)
);

CREATE INDEX IF NOT EXISTS storage_capacity_targets_due_idx
  ON storage_capacity_targets (next_run_at)
  WHERE enabled = true;

-- CREATE TABLE IF NOT EXISTS 済みの開発DBへmigrationを再適用しても制約を揃える。
ALTER TABLE storage_capacity_targets ALTER COLUMN last_status SET DEFAULT 'waiting';
UPDATE storage_capacity_targets SET last_status = 'waiting' WHERE last_status IS NULL;
ALTER TABLE storage_capacity_targets ALTER COLUMN last_status SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_capacity_targets_failures_check') THEN
    ALTER TABLE storage_capacity_targets ADD CONSTRAINT storage_capacity_targets_failures_check
      CHECK (consecutive_failures >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS storage_capacity_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  connection_id  TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket         TEXT        NOT NULL,
  total_bytes    BIGINT      NOT NULL CHECK (total_bytes >= 0),
  object_count   BIGINT      NOT NULL CHECK (object_count >= 0),
  collected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_id         INTEGER     REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS storage_capacity_snapshots_job_idx
  ON storage_capacity_snapshots (job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS storage_capacity_snapshots_history_idx
  ON storage_capacity_snapshots (connection_id, bucket, collected_at DESC);

ALTER TABLE storage_capacity_targets OWNER TO dashboard_rw;
ALTER TABLE storage_capacity_snapshots OWNER TO dashboard_rw;
ALTER SEQUENCE storage_capacity_snapshots_id_seq OWNER TO dashboard_rw;
GRANT SELECT ON storage_capacity_targets, storage_capacity_snapshots TO dashboard_ro;
