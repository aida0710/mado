-- Team notes (postgres notes テーブル) の編集履歴。S3 README の history と同形。
-- pg_trgm extension は 002 で既に CREATE 済 (IF NOT EXISTS なので再実行しても無害)。

CREATE TABLE IF NOT EXISTS notes_history (
  id         BIGSERIAL    PRIMARY KEY,
  slug       TEXT         NOT NULL,
  body       TEXT         NOT NULL,
  size_bytes INTEGER      NOT NULL,
  editor     TEXT         NOT NULL,
  edited_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 同一 slug の版を最新順に
CREATE INDEX IF NOT EXISTS notes_history_slug_at_idx
  ON notes_history (slug, edited_at DESC);

-- 編集者で絞り込み
CREATE INDEX IF NOT EXISTS notes_history_editor_idx
  ON notes_history (editor, edited_at DESC);

-- LIKE / 全文検索向け trigram (002 で extension 作成済)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS notes_history_body_trgm_idx
  ON notes_history USING GIN (body gin_trgm_ops);

ALTER TABLE    notes_history         OWNER TO dashboard_rw;
ALTER SEQUENCE notes_history_id_seq  OWNER TO dashboard_rw;
GRANT SELECT ON notes_history TO dashboard_ro;
