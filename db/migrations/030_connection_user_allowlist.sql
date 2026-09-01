-- Connections are visible to every authenticated user by default. Selected
-- connections can opt into a user allowlist; connection managers always keep
-- access so a mistaken empty allowlist can be repaired from the UI.

ALTER TABLE storage_connections
  ADD COLUMN IF NOT EXISTS visibility_mode TEXT NOT NULL DEFAULT 'public';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'storage_connections_visibility_mode_check'
  ) THEN
    ALTER TABLE storage_connections
      ADD CONSTRAINT storage_connections_visibility_mode_check
      CHECK (visibility_mode IN ('public', 'whitelist'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS connection_user_allowlist (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by      UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, user_id)
);

CREATE INDEX IF NOT EXISTS connection_user_allowlist_user_idx
  ON connection_user_allowlist (user_id, connection_id);

ALTER TABLE connection_user_allowlist OWNER TO dashboard_rw;
GRANT SELECT ON connection_user_allowlist TO dashboard_ro;

