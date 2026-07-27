-- データの家系図（親子リンク）。bucket/directory/file を任意にノード化し、
-- 手動登録の親子エッジだけを持つ (spec: 2026-07-24-data-lineage-graph-design.md)。
-- ノード自体はテーブルを持たず (bucket, path) の組がそのまま識別子になる。
-- path === '' はバケット直下、末尾 '/' はディレクトリ、それ以外はファイル key。

CREATE TABLE IF NOT EXISTS storage_lineage_links (
  id            BIGSERIAL   PRIMARY KEY,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  parent_bucket TEXT        NOT NULL,
  parent_path   TEXT        NOT NULL,
  child_bucket  TEXT        NOT NULL,
  child_path    TEXT        NOT NULL,
  created_by    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((parent_bucket, parent_path) IS DISTINCT FROM (child_bucket, child_path)),
  UNIQUE (connection_id, parent_bucket, parent_path, child_bucket, child_path)
);

CREATE INDEX IF NOT EXISTS storage_lineage_links_conn_idx
  ON storage_lineage_links (connection_id);

CREATE INDEX IF NOT EXISTS storage_lineage_links_parent_idx
  ON storage_lineage_links (connection_id, parent_bucket, parent_path);

CREATE INDEX IF NOT EXISTS storage_lineage_links_child_idx
  ON storage_lineage_links (connection_id, child_bucket, child_path);

ALTER TABLE    storage_lineage_links         OWNER TO dashboard_rw;
ALTER SEQUENCE storage_lineage_links_id_seq  OWNER TO dashboard_rw;
GRANT SELECT ON storage_lineage_links TO dashboard_ro;
