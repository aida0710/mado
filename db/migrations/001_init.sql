CREATE TABLE IF NOT EXISTS hpc_metrics (
  id           BIGSERIAL   PRIMARY KEY,
  host         TEXT        NOT NULL,
  command      TEXT        NOT NULL,
  -- Free-text bucket: "node使用率" / "実行ジョブ数" / "トークン数" / ...
  category     TEXT        NOT NULL DEFAULT 'general',
  output       TEXT        NOT NULL,
  exit_code    INTEGER,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hpc_metrics_host_command_collected
  ON hpc_metrics(host, command, collected_at DESC);

CREATE OR REPLACE VIEW hpc_metrics_latest AS
SELECT DISTINCT ON (host, command, category) *
FROM   hpc_metrics
ORDER  BY host, command, category, collected_at DESC;

CREATE TABLE IF NOT EXISTS s3_readme_meta (
  bucket          TEXT        NOT NULL,
  prefix          TEXT        NOT NULL,
  last_editor     TEXT        NOT NULL,
  last_edited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  size_bytes      INTEGER,
  PRIMARY KEY (bucket, prefix)
);

-- Lab-shared favorite-bucket list. A bucket appears here = pinned for
-- everyone. No per-user state, no ordering — alphabetic in the UI.
CREATE TABLE IF NOT EXISTS s3_favorite_buckets (
  bucket     TEXT        PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
