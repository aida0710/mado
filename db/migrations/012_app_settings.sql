-- db/migrations/012_app_settings.sql
-- アプリ全体の設定 (接続に紐づかない、Mado 全体で 1 つ)。
--
-- value は BOOLEAN ではなく TEXT。設定は必ず増えるので、boolean 以外
-- (デフォルトで開くページ等の文字列設定) が来たときにテーブルを作り直さずに
-- 済むようにする。型の解釈はアプリ側の責務。
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 既存の挙動を変えないため、家系図タブは有効を初期値にする。
-- ON CONFLICT DO NOTHING: このファイルは既存 DB へ手で再適用されうる
-- (db/README.md の「既存 DB へのマイグレーション適用手順」) ため、
-- 再実行しても運用中の設定値を初期値へ戻さない。
INSERT INTO app_settings (key, value) VALUES ('lineage_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;

-- README/Favorites と同じく LAN 共有・認証なしの前提。編集者記録は持たない。
ALTER TABLE app_settings OWNER TO dashboard_rw;
GRANT SELECT ON app_settings TO dashboard_ro;
