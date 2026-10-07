DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mado_worker') THEN
    CREATE ROLE mado_worker NOLOGIN;
  END IF;
END
$$;
GRANT CONNECT ON DATABASE dashboard TO mado_worker;
GRANT USAGE ON SCHEMA public TO mado_worker;
GRANT SELECT ON storage_connections, connection_settings TO mado_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON media_cache, jobs, pricing_cache,
  storage_capacity_snapshots, storage_capacity_prefix_snapshots TO mado_worker;
GRANT SELECT, INSERT, UPDATE ON storage_capacity_targets TO mado_worker;
GRANT SELECT, UPDATE ON storage_capacity_settings TO mado_worker;
GRANT USAGE, SELECT ON SEQUENCE jobs_id_seq, storage_capacity_snapshots_id_seq TO mado_worker;
