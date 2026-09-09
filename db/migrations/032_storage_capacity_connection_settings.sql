-- 容量計測の有効化と周期はbucket単位ではなくconnection単位で管理する。
-- migrationだけでは新しい定期走査を開始しない。既存のbucket別設定がある場合も、
-- 1 bucketから全bucketへ対象が拡大するため、周期だけ引き継いで明示的な再有効化を待つ。

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

WITH migrated AS (
  INSERT INTO storage_capacity_settings
    (connection_id, enabled, interval_seconds, next_run_at, last_status)
  SELECT connection_id,
         false,
         min(interval_seconds),
         NULL,
         'paused'
    FROM storage_capacity_targets
   GROUP BY connection_id
  ON CONFLICT (connection_id) DO NOTHING
  RETURNING connection_id
)
UPDATE storage_capacity_targets target
   SET enabled = false, last_status = 'paused', updated_at = now()
  FROM migrated
 WHERE target.connection_id = migrated.connection_id;

CREATE INDEX IF NOT EXISTS storage_capacity_settings_due_idx
  ON storage_capacity_settings (next_run_at)
  WHERE enabled = true;

ALTER TABLE storage_capacity_settings OWNER TO dashboard_rw;
GRANT SELECT ON storage_capacity_settings TO dashboard_ro;
