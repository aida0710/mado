-- Local loginは送信元IPとArgon2同時実行数でresourceを保護する。
-- User単位の失敗回数・lock期限は標的型DoSになるため永続化しない。

ALTER TABLE auth_local_credentials
  DROP COLUMN IF EXISTS failed_attempts,
  DROP COLUMN IF EXISTS locked_until;
