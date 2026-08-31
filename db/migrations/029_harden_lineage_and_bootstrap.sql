-- Remove the untouched, publicly-known bootstrap credential and provision a
-- least-privilege database role for the Internet-facing OpenLineage process.
-- Operators create/reset the first admin offline with bootstrap-admin.js.

DELETE FROM auth_users u
USING auth_local_credentials lc
WHERE u.id = lc.user_id
  AND u.id = '722c09cd-bcb9-4730-9128-f6213cf0fd97'::uuid
  AND lower(u.username) = 'admin'
  AND u.last_login_at IS NULL
  AND lc.must_change_password = TRUE
  AND lc.password_hash = '$argon2id$v=19$m=19456,p=1,t=2$8oOsWtdAXDOIjP/riC899g$sViBQ9sggkfFP0TRMI+bzulPPHojFXMewKlCQ/Xaxkg';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mado_lineage') THEN
    CREATE ROLE mado_lineage NOLOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE dashboard TO mado_lineage;
GRANT USAGE ON SCHEMA public TO mado_lineage;
GRANT SELECT ON service_accounts, service_account_keys,
  service_account_key_scopes, service_account_key_namespaces TO mado_lineage;
GRANT UPDATE (last_used_at) ON service_account_keys TO mado_lineage;
GRANT INSERT ON audit_events TO mado_lineage;
-- createAuditWriter uses INSERT ... RETURNING id. PostgreSQL requires SELECT
-- privilege on every column referenced by RETURNING, while the role must not
-- gain read access to the rest of the audit log.
GRANT SELECT (id) ON audit_events TO mado_lineage;
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO mado_lineage;
