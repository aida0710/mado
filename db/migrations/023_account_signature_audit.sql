-- Account-owned signatures and authenticated authors for document history.

ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS signature_name TEXT;

UPDATE auth_users
   SET signature_name = display_name
 WHERE signature_name IS NULL OR btrim(signature_name) = '';

ALTER TABLE auth_users ALTER COLUMN signature_name SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_users_signature_name_length_check'
  ) THEN
    ALTER TABLE auth_users ADD CONSTRAINT auth_users_signature_name_length_check
      CHECK (length(btrim(signature_name)) BETWEEN 1 AND 128);
  END IF;
END $$;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS last_editor_user_id UUID;
ALTER TABLE notes_history ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE storage_readme_meta ADD COLUMN IF NOT EXISTS last_editor_user_id UUID;
ALTER TABLE storage_readme_history ADD COLUMN IF NOT EXISTS actor_user_id UUID;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notes_last_editor_user_id_fkey'
  ) THEN
    ALTER TABLE notes ADD CONSTRAINT notes_last_editor_user_id_fkey
      FOREIGN KEY (last_editor_user_id) REFERENCES auth_users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notes_history_actor_user_id_fkey'
  ) THEN
    ALTER TABLE notes_history ADD CONSTRAINT notes_history_actor_user_id_fkey
      FOREIGN KEY (actor_user_id) REFERENCES auth_users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'storage_readme_meta_last_editor_user_id_fkey'
  ) THEN
    ALTER TABLE storage_readme_meta ADD CONSTRAINT storage_readme_meta_last_editor_user_id_fkey
      FOREIGN KEY (last_editor_user_id) REFERENCES auth_users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'storage_readme_history_actor_user_id_fkey'
  ) THEN
    ALTER TABLE storage_readme_history ADD CONSTRAINT storage_readme_history_actor_user_id_fkey
      FOREIGN KEY (actor_user_id) REFERENCES auth_users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notes_history_actor_user_idx
  ON notes_history (actor_user_id, edited_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storage_readme_history_actor_user_idx
  ON storage_readme_history (actor_user_id, edited_at DESC) WHERE actor_user_id IS NOT NULL;
