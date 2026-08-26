-- Keep the actor row for historical audit attribution after an administrator
-- removes a user from the active directory.
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS auth_users_not_deleted_idx
  ON auth_users (created_at, id) WHERE deleted_at IS NULL;
