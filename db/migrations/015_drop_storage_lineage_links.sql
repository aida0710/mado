-- 家系図 (データの親子リンク) 機能の撤去。テーブルと表示トグルの設定行を落とす。
--
-- 010_storage_lineage_links.sql は削除済みなので、新規 DB ではどちらも no-op。
-- 既存 DB では登録済みのリンクが消える — 適用前に pg_dump を取ること
-- (db/README.md の「既存 DB へのマイグレーション適用手順」)。

DROP TABLE IF EXISTS storage_lineage_links;

DELETE FROM app_settings WHERE key = 'lineage_enabled';
