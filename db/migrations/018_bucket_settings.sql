-- バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
-- 設定は app_settings (全体) と connection_settings (接続ごと) があり、
-- バケット単位だけが無かった。connection_settings と同じ key/value 形式。
CREATE TABLE IF NOT EXISTS bucket_settings (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, key),
  CHECK (length(key) BETWEEN 1 AND 64)
);

-- README/Favorites と同じく LAN 共有・認証なしの前提。編集者記録は持たない。
ALTER TABLE bucket_settings OWNER TO dashboard_rw;
GRANT SELECT ON bucket_settings TO dashboard_ro;
