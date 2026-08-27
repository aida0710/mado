-- OIDC authorization transactionを開始browserのHttpOnly cookieへ結び付ける。
-- 既存の未完attemptはbindingを持たないため、安全側に倒して破棄する。

ALTER TABLE auth_oidc_attempts
  ADD COLUMN IF NOT EXISTS browser_binding_hash BYTEA;

DELETE FROM auth_oidc_attempts WHERE browser_binding_hash IS NULL;

ALTER TABLE auth_oidc_attempts
  ALTER COLUMN browser_binding_hash SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'auth_oidc_attempts_browser_binding_hash_length_check'
  ) THEN
    ALTER TABLE auth_oidc_attempts
      ADD CONSTRAINT auth_oidc_attempts_browser_binding_hash_length_check
      CHECK (octet_length(browser_binding_hash) = 32);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS auth_oidc_attempts_binding_pending_idx
  ON auth_oidc_attempts (browser_binding_hash, expires_at)
  WHERE used_at IS NULL;
