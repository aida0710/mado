-- デフォルト接続 (spec: 2026-07-07-default-connection-design.md)
-- Storage タブはデフォルト接続へ直行する。デフォルトは常に 1 件以下。
-- 権限の追記は不要: 既存テーブルへの ALTER は所有者 (dashboard_rw) を変えず、
-- インデックスは常に親テーブルの所有者に属する。

ALTER TABLE storage_connections
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS storage_connections_default
  ON storage_connections (is_default) WHERE is_default;

-- 既存環境: 登録順で最初の接続をデフォルトに焼き込む (0 件 / 既にあるなら no-op)
UPDATE storage_connections SET is_default = true
 WHERE id = (SELECT id FROM storage_connections ORDER BY created_at, id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM storage_connections WHERE is_default);
