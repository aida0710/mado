-- 容量計測の有効化と周期はbucket単位ではなくconnection単位で管理する。
-- migrationだけでは新しい定期走査を開始しない。既存のbucket別設定がある場合だけ
-- 最短周期を引き継ぎ、1件でも有効ならconnection全体を有効として移行する。

CREATE TABLE IF NOT EXISTS storage_capacity_settings (
  connection_id        TEXT        PRIMARY KEY REFERENCES storage_connections(id) ON DELETE CASCADE,
  enabled              BOOLEAN     NOT NULL DEFAULT false,
  interval_seconds     INTEGER     NOT NULL DEFAULT 86400
    CHECK (interval_seconds BETWEEN 21600 AND 604800),
  next_run_at          TIMESTAMPTZ,
  last_attempt_at      TIMESTAMPTZ,
  last_status          TEXT        NOT NULL DEFAULT 'paused'
    CHECK (last_status IN ('waiting', 'queued', 'error', 'paused')),
  last_error           TEXT,
  consecutive_failures INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID        REFERENCES auth_users(id) ON DELETE SET NULL
);

INSERT INTO storage_capacity_settings
  (connection_id, enabled, interval_seconds, next_run_at, last_status)
SELECT connection_id,
       bool_or(enabled),
       min(interval_seconds),
       CASE WHEN bool_or(enabled) THEN min(next_run_at) ELSE NULL END,
       CASE WHEN bool_or(enabled) THEN 'waiting' ELSE 'paused' END
  FROM storage_capacity_targets
 GROUP BY connection_id
ON CONFLICT (connection_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS storage_capacity_settings_due_idx
  ON storage_capacity_settings (next_run_at)
  WHERE enabled = true;

ALTER TABLE storage_capacity_settings OWNER TO dashboard_rw;
GRANT SELECT ON storage_capacity_settings TO dashboard_ro;
