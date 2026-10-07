-- tokenはAPIの鍵で暗号化する。旧sessionは次の要求で再ログインを求める。
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS oidc_access_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS oidc_refresh_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS oidc_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oidc_checked_at TIMESTAMPTZ;
