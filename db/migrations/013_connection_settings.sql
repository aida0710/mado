-- 接続ごとの設定 (key/value)。第一の用途は権限 (capability) トグル。
--
-- 動機: Mado は「一覧を眺める」用途と「中身を触る」用途が同じ画面に同居している。
-- Glacier Deep Archive のように **GetObject 自体が失敗する / 復元課金が発生する**
-- バケットや、書き戻したくない本番バケットを登録した接続では、list は許したいが
-- ダウンロード・アーカイブ展開・音声解析・README の書き戻しは踏ませたくない。
--
-- 設計:
-- - storage_connections に boolean カラムを足すのではなく、012 の app_settings と
--   同じ key/value 形。設定は必ず増えるので、増えるたびに ALTER TABLE と
--   マイグレーションの手当てをするのを避ける。value は TEXT で、型の解釈はアプリ側。
-- - **行が無い = 既定値**。権限の既定はすべて有効なので、このテーブルが空なら
--   マイグレーション適用前と挙動は完全に同じ。既存接続へのバックフィルも不要で、
--   中身は「既定から外した例外だけ」に近い状態を保つ。
-- - key は `cap.<capability 名>` (`cap.download`, `cap.readmeWrite` …)。将来
--   権限以外の接続別設定を足すときは別の名前空間を使う。
-- - 「README の編集には読み込みが必要」のような組み合わせ制約は key/value では
--   表現できないので、API 側 (routes/connections.ts) で 400 として弾く。
--
-- 認証は無い (LAN 境界が前提) ため、これはアクセス制御ではなく **誤操作の防止**。
-- ただし UI で隠すだけでは共有 Web URL を直接叩けてしまうので、API 側でも
-- lib/capabilityGuard.ts が 403 で止める。

CREATE TABLE IF NOT EXISTS connection_settings (
  connection_id TEXT        NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  key           TEXT        NOT NULL,
  value         TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, key),
  CHECK (length(key) BETWEEN 1 AND 64)
);

-- README/Favorites と同じく LAN 共有・認証なしの前提。編集者記録は持たない。
ALTER TABLE connection_settings OWNER TO dashboard_rw;
GRANT SELECT ON connection_settings TO dashboard_ro;
