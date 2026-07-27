-- db/migrations/011_storage_tags.sql
-- 事前定義タグ + bucket/ディレクトリ/ファイルへの割り当て
-- (spec: docs/superpowers/specs/2026-07-24-storage-tags-design.md)

-- 事前定義タグのレジストリ。全接続共通 (connection_id を持たない)。
CREATE TABLE IF NOT EXISTS storage_tags (
  id         TEXT        PRIMARY KEY,        -- nanoid(10)
  name       TEXT        NOT NULL UNIQUE,
  color      TEXT        NOT NULL,            -- '#RRGGBB'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(name) BETWEEN 1 AND 32),
  CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  CHECK (length(id) = 10)
);

-- タグの割り当て。bucket 自体 / prefix (ディレクトリ) / file (key) の
-- 3種類の対象をひとつのテーブルで表現する (target_kind で判別)。
-- 種別ごとにテーブルを分けず統合することで、CRUD ロジックの重複を避ける。
CREATE TABLE IF NOT EXISTS storage_tag_assignments (
  tag_id        TEXT        NOT NULL REFERENCES storage_tags(id) ON DELETE CASCADE,
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  bucket        TEXT        NOT NULL,
  target_kind   TEXT        NOT NULL CHECK (target_kind IN ('bucket','prefix','file')),
  target_path   TEXT        NOT NULL DEFAULT '',  -- bucket: '' / prefix: 'a/b/' / file: 'a/b/c.txt'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, bucket, target_kind, target_path, tag_id)
);

CREATE INDEX IF NOT EXISTS storage_tag_assignments_tag_idx
  ON storage_tag_assignments (tag_id);

-- 既存テーブルと同じく rw 所有 + ro SELECT。
ALTER TABLE storage_tags            OWNER TO dashboard_rw;
ALTER TABLE storage_tag_assignments OWNER TO dashboard_rw;
GRANT SELECT ON storage_tags, storage_tag_assignments TO dashboard_ro;
