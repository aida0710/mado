CREATE TABLE IF NOT EXISTS storage_connections (
  id                    TEXT        PRIMARY KEY,             -- nanoid(10)
  name                  TEXT        NOT NULL UNIQUE,
  endpoint              TEXT        NOT NULL,
  region                TEXT        NOT NULL DEFAULT 'auto',
  access_key_id_enc     TEXT        NOT NULL,                 -- v1:iv:tag:ct
  secret_access_key_enc TEXT        NOT NULL,                 -- v1:iv:tag:ct
  access_key_id_masked  TEXT        NOT NULL,                 -- "AKIA…XYZ4"
  force_path_style      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(name)     BETWEEN 1 AND 64),
  CHECK (length(endpoint) BETWEEN 1 AND 512),
  CHECK (length(region)   BETWEEN 1 AND 64),
  CHECK (length(id) = 10)
);

CREATE OR REPLACE FUNCTION storage_connections_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_connections_set_updated_at ON storage_connections;
CREATE TRIGGER storage_connections_set_updated_at
BEFORE UPDATE ON storage_connections
FOR EACH ROW EXECUTE FUNCTION storage_connections_touch_updated_at();

CREATE TABLE IF NOT EXISTS storage_readme_meta (
  connection_id   TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket          TEXT        NOT NULL,
  prefix          TEXT        NOT NULL,
  last_editor     TEXT        NOT NULL,
  last_edited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  size_bytes      INTEGER,
  PRIMARY KEY (connection_id, bucket, prefix)
);

-- LAN-shared favorite-bucket list. A bucket appears here = pinned for
-- everyone (within a connection). No per-user state, no ordering — alphabetic in the UI.
CREATE TABLE IF NOT EXISTS storage_favorite_buckets (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket)
);

-- LAN-shared markdown notes, slug-keyed. The home page reads slug='home'.
CREATE TABLE IF NOT EXISTS notes (
  slug           TEXT        PRIMARY KEY,
  body           TEXT        NOT NULL DEFAULT '',
  last_editor    TEXT,
  last_edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(slug) BETWEEN 1 AND 64)
);
