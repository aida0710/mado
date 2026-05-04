-- README 編集の全履歴 (audit trail)。
-- storage_readme_meta は最新版だけを引き当てるための index、ここは時系列の append-only。

CREATE TABLE IF NOT EXISTS storage_readme_history (
  id            BIGSERIAL    PRIMARY KEY,
  connection_id TEXT         NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT         NOT NULL,
  prefix        TEXT         NOT NULL,
  body          TEXT         NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  editor        TEXT         NOT NULL,
  edited_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 同一 README の版を最新順に取り出す
CREATE INDEX IF NOT EXISTS storage_readme_history_path_at_idx
  ON storage_readme_history (connection_id, bucket, prefix, edited_at DESC);

-- 編集者で絞り込みたい場合用 ("田中の編集だけ" 等)
CREATE INDEX IF NOT EXISTS storage_readme_history_editor_idx
  ON storage_readme_history (editor, edited_at DESC);

-- LIKE '%q%' を含むカジュアル全文検索を高速化する trigram index。
-- pg_trgm は postgres official image に標準で入っている contrib モジュール。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS storage_readme_history_body_trgm_idx
  ON storage_readme_history USING GIN (body gin_trgm_ops);

-- 既存テーブルと同じく rw 所有 + ro SELECT。
ALTER TABLE    storage_readme_history         OWNER TO dashboard_rw;
ALTER SEQUENCE storage_readme_history_id_seq  OWNER TO dashboard_rw;
GRANT SELECT ON storage_readme_history TO dashboard_ro;
