-- RegistryのStorageSystemとMadoのS3 connectionを結ぶ。
--
-- Registryにはendpointの論理IDだけを置き、credentialは従来どおりMadoの
-- storage_connectionsだけが保持する。接続を削除したときはbindingも削除するが、
-- Registry側のStorageLocationは消さない。

CREATE TABLE IF NOT EXISTS lineage_storage_bindings (
  connection_id               TEXT        PRIMARY KEY
    REFERENCES storage_connections(id) ON DELETE CASCADE,
  registry_storage_system_key TEXT        NOT NULL UNIQUE,
  created_by                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(registry_storage_system_key) BETWEEN 1 AND 256)
);

CREATE OR REPLACE FUNCTION lineage_storage_bindings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lineage_storage_bindings_set_updated_at ON lineage_storage_bindings;
CREATE TRIGGER lineage_storage_bindings_set_updated_at
BEFORE UPDATE ON lineage_storage_bindings
FOR EACH ROW EXECUTE FUNCTION lineage_storage_bindings_touch_updated_at();

ALTER TABLE lineage_storage_bindings OWNER TO dashboard_rw;
GRANT SELECT ON lineage_storage_bindings TO dashboard_ro;
