-- タグ機能の全体トグル。
--
-- 既存の挙動を変えないため初期値は有効。ON CONFLICT DO NOTHING —
-- このファイルは既存 DB へ手で再適用されうるので
-- (db/README.md の「既存 DB へのマイグレーション適用手順」)、
-- 再実行しても運用中の設定値を初期値へ戻さない。

INSERT INTO app_settings (key, value) VALUES ('tags_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;
