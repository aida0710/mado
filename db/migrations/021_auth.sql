-- Mado authentication / authorization foundation.
--
-- Browser users authenticate with an opaque database-backed session. Pipelines
-- authenticate independently through service-account keys. Raw session and API
-- key secrets are never stored; only SHA-256 digests are persisted.

CREATE TABLE IF NOT EXISTS auth_users (
  id                    UUID        PRIMARY KEY,
  username              TEXT,
  email                 TEXT,
  display_name          TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at         TIMESTAMPTZ,
  CHECK (length(display_name) BETWEEN 1 AND 128),
  CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320)
);

-- Keep this migration re-runnable for development databases created before
-- local usernames were introduced.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS username TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_users_username_format_check'
  ) THEN
    ALTER TABLE auth_users ADD CONSTRAINT auth_users_username_format_check
      CHECK (username IS NULL OR username ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_username_unique_idx
  ON auth_users (lower(username)) WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_unique_idx
  ON auth_users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_oidc_identities (
  issuer                TEXT        NOT NULL,
  subject               TEXT        NOT NULL,
  user_id               UUID        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  email_at_login        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  CHECK (length(issuer) BETWEEN 1 AND 2048),
  CHECK (length(subject) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS auth_oidc_identities_user_idx
  ON auth_oidc_identities (user_id);

CREATE TABLE IF NOT EXISTS auth_local_credentials (
  user_id               UUID        PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  password_hash         TEXT        NOT NULL,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_attempts       INT         NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          TIMESTAMPTZ,
  must_change_password  BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS auth_roles (
  id                    TEXT        PRIMARY KEY,
  description           TEXT        NOT NULL DEFAULT '',
  builtin               BOOLEAN     NOT NULL DEFAULT FALSE,
  CHECK (id ~ '^[a-z][a-z0-9_.:-]{0,63}$')
);

CREATE TABLE IF NOT EXISTS auth_permissions (
  id                    TEXT        PRIMARY KEY,
  description           TEXT        NOT NULL DEFAULT '',
  CHECK (id ~ '^[a-z][a-z0-9_.:-]{0,127}$')
);

CREATE TABLE IF NOT EXISTS auth_role_permissions (
  role_id               TEXT        NOT NULL REFERENCES auth_roles(id) ON DELETE CASCADE,
  permission_id         TEXT        NOT NULL REFERENCES auth_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS auth_user_roles (
  user_id               UUID        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role_id               TEXT        NOT NULL REFERENCES auth_roles(id) ON DELETE RESTRICT,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by            UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS auth_user_roles_role_idx ON auth_user_roles (role_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash            BYTEA       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at       TIMESTAMPTZ NOT NULL,
  absolute_expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  ip_address            INET,
  user_agent            TEXT,
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (user_agent IS NULL OR length(user_agent) <= 1024)
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
  ON auth_sessions (user_id, absolute_expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
  ON auth_sessions (absolute_expires_at);

-- Short-lived OIDC authorization state. nonce and PKCE verifier are encrypted
-- with the existing ENCRYPTION_KEY because the callback needs their plaintext.
CREATE TABLE IF NOT EXISTS auth_oidc_attempts (
  state_hash            BYTEA       PRIMARY KEY CHECK (octet_length(state_hash) = 32),
  provider_id           TEXT        NOT NULL,
  nonce_enc             TEXT        NOT NULL,
  code_verifier_enc     TEXT        NOT NULL,
  return_to             TEXT        NOT NULL DEFAULT '/',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  CHECK (return_to LIKE '/%' AND return_to NOT LIKE '//%'),
  CHECK (length(return_to) <= 2048)
);

CREATE INDEX IF NOT EXISTS auth_oidc_attempts_expiry_idx
  ON auth_oidc_attempts (expires_at);

CREATE TABLE IF NOT EXISTS service_accounts (
  id                    UUID        PRIMARY KEY,
  name                  TEXT        NOT NULL UNIQUE,
  description           TEXT        NOT NULL DEFAULT '',
  status                TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled')),
  created_by            UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(name) BETWEEN 1 AND 128),
  CHECK (length(description) <= 2048)
);

CREATE TABLE IF NOT EXISTS service_account_keys (
  id                    UUID        PRIMARY KEY,
  service_account_id    UUID        NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  token_prefix          TEXT        NOT NULL UNIQUE,
  secret_hash           BYTEA       NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_by            UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  CHECK (length(name) BETWEEN 1 AND 128),
  CHECK (token_prefix ~ '^mado_lin_[A-Za-z0-9_-]{8,32}$')
);

CREATE INDEX IF NOT EXISTS service_account_keys_account_idx
  ON service_account_keys (service_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS service_account_key_scopes (
  key_id                UUID        NOT NULL REFERENCES service_account_keys(id) ON DELETE CASCADE,
  scope                 TEXT        NOT NULL,
  PRIMARY KEY (key_id, scope),
  CHECK (scope ~ '^[a-z][a-z0-9_.:-]{0,127}$')
);

CREATE TABLE IF NOT EXISTS service_account_key_namespaces (
  key_id                UUID        NOT NULL REFERENCES service_account_keys(id) ON DELETE CASCADE,
  namespace             TEXT        NOT NULL,
  PRIMARY KEY (key_id, namespace),
  CHECK (length(namespace) BETWEEN 1 AND 512)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id                    BIGSERIAL   PRIMARY KEY,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id            UUID,
  actor_type            TEXT        NOT NULL CHECK (actor_type IN ('user', 'service_account', 'anonymous', 'system')),
  actor_user_id         UUID        REFERENCES auth_users(id) ON DELETE SET NULL,
  actor_service_account_id UUID     REFERENCES service_accounts(id) ON DELETE SET NULL,
  action                TEXT        NOT NULL,
  resource_type         TEXT,
  resource_id           TEXT,
  outcome               TEXT        NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  ip_address            INET,
  user_agent            TEXT,
  details               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CHECK (length(action) BETWEEN 1 AND 128),
  CHECK (resource_type IS NULL OR length(resource_type) <= 128),
  CHECK (resource_id IS NULL OR length(resource_id) <= 1024),
  CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_user_idx
  ON audit_events (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_service_idx
  ON audit_events (actor_service_account_id, occurred_at DESC)
  WHERE actor_service_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, occurred_at DESC);

-- Built-in permissions and roles. Re-running the migration is safe and preserves
-- locally edited descriptions while ensuring every required row exists.
INSERT INTO auth_permissions (id, description) VALUES
  ('storage:read',            'ストレージ一覧・プレビュー・ダウンロード'),
  ('content:write',           'README・ノート・タグの編集'),
  ('lineage:read',            'データセットとlineageの閲覧'),
  ('lineage:curate',          'データセットmetadataの編集'),
  ('jobs:operate',            '走査・ジョブ・料金更新の実行'),
  ('connections:manage',      'S3接続の作成・更新・削除'),
  ('settings:manage',         'アプリ設定の変更'),
  ('users:manage',            'ユーザーとRoleの管理'),
  ('service_accounts:manage', 'Service AccountとAPI keyの管理'),
  ('audit:read',              '監査ログの閲覧')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_roles (id, description, builtin) VALUES
  ('viewer',   '閲覧者', TRUE),
  ('curator',  'データキュレーター', TRUE),
  ('operator', '処理オペレーター', TRUE),
  ('admin',    '管理者', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_role_permissions (role_id, permission_id) VALUES
  ('viewer',   'storage:read'),
  ('viewer',   'lineage:read'),
  ('curator',  'storage:read'),
  ('curator',  'lineage:read'),
  ('curator',  'content:write'),
  ('curator',  'lineage:curate'),
  ('operator', 'storage:read'),
  ('operator', 'lineage:read'),
  ('operator', 'jobs:operate'),
  ('admin',    'storage:read'),
  ('admin',    'content:write'),
  ('admin',    'lineage:read'),
  ('admin',    'lineage:curate'),
  ('admin',    'jobs:operate'),
  ('admin',    'connections:manage'),
  ('admin',    'settings:manage'),
  ('admin',    'users:manage'),
  ('admin',    'service_accounts:manage'),
  ('admin',    'audit:read')
ON CONFLICT DO NOTHING;

-- OSS installation bootstrap account. The repository contains only this
-- Argon2id hash, and the account cannot continue past first sign-in without
-- replacing the known initial credential with a 12+ byte password.
WITH inserted_admin AS (
  INSERT INTO auth_users (id, username, email, display_name, status)
  SELECT
    '722c09cd-bcb9-4730-9128-f6213cf0fd97'::uuid,
    'admin', NULL, 'Mado Administrator', 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM auth_users WHERE lower(username) = 'admin'
  )
  RETURNING id
)
INSERT INTO auth_local_credentials
  (user_id, password_hash, password_changed_at, failed_attempts, locked_until, must_change_password)
SELECT
  id,
  '$argon2id$v=19$m=19456,p=1,t=2$8oOsWtdAXDOIjP/riC899g$sViBQ9sggkfFP0TRMI+bzulPPHojFXMewKlCQ/Xaxkg',
  now(), 0, NULL, TRUE
FROM inserted_admin
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth_user_roles (user_id, role_id, granted_by)
SELECT id, 'admin', id FROM auth_users WHERE lower(username) = 'admin'
ON CONFLICT (user_id, role_id) DO NOTHING;

ALTER TABLE auth_users                          OWNER TO dashboard_rw;
ALTER TABLE auth_oidc_identities                OWNER TO dashboard_rw;
ALTER TABLE auth_local_credentials              OWNER TO dashboard_rw;
ALTER TABLE auth_roles                          OWNER TO dashboard_rw;
ALTER TABLE auth_permissions                    OWNER TO dashboard_rw;
ALTER TABLE auth_role_permissions               OWNER TO dashboard_rw;
ALTER TABLE auth_user_roles                     OWNER TO dashboard_rw;
ALTER TABLE auth_sessions                       OWNER TO dashboard_rw;
ALTER TABLE auth_oidc_attempts                   OWNER TO dashboard_rw;
ALTER TABLE service_accounts                    OWNER TO dashboard_rw;
ALTER TABLE service_account_keys                OWNER TO dashboard_rw;
ALTER TABLE service_account_key_scopes          OWNER TO dashboard_rw;
ALTER TABLE service_account_key_namespaces      OWNER TO dashboard_rw;
ALTER TABLE audit_events                        OWNER TO dashboard_rw;
ALTER SEQUENCE audit_events_id_seq              OWNER TO dashboard_rw;

GRANT SELECT ON
  auth_users, auth_oidc_identities, auth_local_credentials,
  auth_roles, auth_permissions, auth_role_permissions, auth_user_roles,
  auth_sessions, auth_oidc_attempts,
  service_accounts, service_account_keys,
  service_account_key_scopes, service_account_key_namespaces,
  audit_events
TO dashboard_ro;
