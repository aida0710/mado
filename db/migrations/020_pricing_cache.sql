-- 料金カタログのキャッシュ (spec: 2026-08-22-transfer-estimate-design.md)。
--
-- 単価は AWS の料金 API から取得するが、Mado は外向き通信が塞がれた環境でも
-- 動く必要がある。そこで 3 層にする:
--
--   プロセス内メモリ (60 秒) → このテーブル → 同梱の api/pricing/catalog.ts
--
-- このテーブルが空でも見積もりは出る (同梱カタログが使われる)。取得できて
-- いないことと無料であることを取り違えさせないよう、UI には出所を必ず出す。
--
-- 常に 1 行。id は BOOLEAN PRIMARY KEY + CHECK で「TRUE の 1 行しか入らない」を
-- DB に守らせるイディオム。行が増えて「どれが最新か」を気にする状態を作らない。
CREATE TABLE IF NOT EXISTS pricing_cache (
  id         BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
  catalog    JSONB       NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- README / Favorites と同じく LAN 共有・認証なしの前提。取得者は記録しない。
ALTER TABLE pricing_cache OWNER TO dashboard_rw;
GRANT SELECT ON pricing_cache TO dashboard_ro;
