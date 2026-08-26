-- Authentikを含むOIDC Providerとのprofile同期・group RBAC・logout連携。

ALTER TABLE auth_oidc_identities
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS groups_at_login TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS oidc_issuer TEXT,
  ADD COLUMN IF NOT EXISTS oidc_subject TEXT,
  ADD COLUMN IF NOT EXISTS oidc_sid TEXT;

ALTER TABLE auth_sessions
  DROP CONSTRAINT IF EXISTS auth_sessions_oidc_identity_complete;
ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_oidc_identity_complete CHECK (
    (oidc_issuer IS NULL AND oidc_subject IS NULL AND oidc_sid IS NULL)
    OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS auth_sessions_oidc_sid_active_idx
  ON auth_sessions (oidc_issuer, oidc_sid)
  WHERE revoked_at IS NULL AND oidc_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_oidc_subject_active_idx
  ON auth_sessions (oidc_issuer, oidc_subject)
  WHERE revoked_at IS NULL AND oidc_subject IS NOT NULL;

-- Back-channel logout tokenのjtiを記録してreplayを拒否する。
CREATE TABLE IF NOT EXISTS auth_oidc_logout_events (
  issuer                TEXT        NOT NULL,
  jti                   TEXT        NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, jti),
  CHECK (length(issuer) BETWEEN 1 AND 2048),
  CHECK (length(jti) BETWEEN 1 AND 512)
);

CREATE INDEX IF NOT EXISTS auth_oidc_logout_events_expiry_idx
  ON auth_oidc_logout_events (expires_at);

ALTER TABLE auth_oidc_logout_events OWNER TO dashboard_rw;
GRANT SELECT, INSERT, DELETE ON auth_oidc_logout_events TO dashboard_rw;
