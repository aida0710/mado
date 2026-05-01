#!/usr/bin/env bash
set -euo pipefail

# コンテナ初回作成時に一度だけ実行される。再実行するには名前付きボリューム `db_data` を削除する必要がある。

PASSWORD="${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD must be set in compose.dev.yaml or compose.prod.yaml}"

# ロールとテスト DB を作成する。デフォルトの `dashboard` DB は POSTGRES_DB から作成済み。
psql -v ON_ERROR_STOP=1 --username "postgres" <<-EOSQL
  CREATE ROLE dashboard_rw LOGIN PASSWORD '${PASSWORD}';
  CREATE ROLE dashboard_ro LOGIN PASSWORD '${PASSWORD}';

  CREATE DATABASE dashboard_test OWNER postgres;

  GRANT ALL ON DATABASE dashboard      TO dashboard_rw;
  GRANT ALL ON DATABASE dashboard_test TO dashboard_rw;
  GRANT CONNECT ON DATABASE dashboard      TO dashboard_ro;
  GRANT CONNECT ON DATABASE dashboard_test TO dashboard_ro;
EOSQL

# スキーマを両方の DB に適用する。正規のスキーマは db/migrations/001_init.sql にあり、
# compose が /migrations/ にマウントする。
for db in dashboard dashboard_test; do
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" \
    -f /migrations/001_init.sql

  # スキーマオブジェクトの所有権を dashboard_rw に移譲する。これにより
  # TRUNCATE / ALTER / DROP が可能になる (GRANT だけでは TRUNCATE ... RESTART IDENTITY
  # などの操作が不十分)。
  # rw は将来の psql 経由マイグレーション用に schema public の CREATE 権限も取得する。
  # ro は明示的な GRANT により SELECT のみのアクセスを維持する。
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" <<-EOSQL
    ALTER TABLE    metrics                              OWNER TO dashboard_rw;
    ALTER SEQUENCE metrics_id_seq                       OWNER TO dashboard_rw;
    ALTER VIEW     metrics_latest                       OWNER TO dashboard_rw;
    ALTER TABLE    storage_connections                  OWNER TO dashboard_rw;
    ALTER FUNCTION storage_connections_touch_updated_at() OWNER TO dashboard_rw;
    ALTER TABLE    storage_readme_meta                  OWNER TO dashboard_rw;
    ALTER TABLE    storage_favorite_buckets             OWNER TO dashboard_rw;
    ALTER TABLE    notes                                OWNER TO dashboard_rw;
    ALTER TABLE    feature_flags                        OWNER TO dashboard_rw;

    GRANT CREATE ON SCHEMA public                  TO dashboard_rw;
    GRANT USAGE  ON SCHEMA public                  TO dashboard_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public    TO dashboard_ro;
    ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_rw IN SCHEMA public
      GRANT SELECT ON TABLES TO dashboard_ro;
EOSQL
done
