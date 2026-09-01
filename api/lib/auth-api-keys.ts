import type { Pool } from 'pg'
import type { ServicePrincipal } from './auth-types.js'
import { equalDigest, newId, randomToken, sha256 } from './auth-crypto.js'

export interface ServiceAccount {
  id: string
  name: string
  description: string
  status: 'active' | 'disabled'
  createdAt: Date
  updatedAt: Date
}

export interface ServiceAccountKey {
  id: string
  serviceAccountId: string
  name: string
  tokenPrefix: string
  scopes: string[]
  namespaces: string[]
  createdAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
}

export interface IssuedServiceAccountKey extends ServiceAccountKey {
  /** 発行時に一度だけ返す。永続化・再取得はできない。 */
  token: string
}

interface AccountRow {
  id: string
  name: string
  description: string
  status: 'active' | 'disabled'
  created_at: Date
  updated_at: Date
}

interface KeyRow {
  id: string
  service_account_id: string
  name: string
  token_prefix: string
  secret_hash: Buffer
  scopes: string[]
  namespaces: string[]
  created_at: Date
  expires_at: Date | null
  revoked_at: Date | null
  last_used_at: Date | null
  account_name?: string
  account_status?: 'active' | 'disabled'
}

const KEY_SELECT = `
  SELECT k.id, k.service_account_id, k.name, k.token_prefix, k.secret_hash,
         k.created_at, k.expires_at, k.revoked_at, k.last_used_at,
         COALESCE((SELECT array_agg(s.scope ORDER BY s.scope)
                    FROM service_account_key_scopes s WHERE s.key_id = k.id), ARRAY[]::text[]) AS scopes,
         COALESCE((SELECT array_agg(n.namespace ORDER BY n.namespace)
                    FROM service_account_key_namespaces n WHERE n.key_id = k.id), ARRAY[]::text[]) AS namespaces
    FROM service_account_keys k`

function toAccount(row: AccountRow): ServiceAccount {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toKey(row: KeyRow): ServiceAccountKey {
  return {
    id: row.id,
    serviceAccountId: row.service_account_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    namespaces: row.namespaces,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }
}

export interface ServiceAccountStore {
  listAccounts(): Promise<ServiceAccount[]>
  getAccount(id: string): Promise<ServiceAccount | null>
  createAccount(input: { name: string; description?: string; createdBy: string }): Promise<ServiceAccount>
  updateAccount(id: string, patch: { name?: string; description?: string; status?: 'active' | 'disabled' }): Promise<ServiceAccount | null>
  updateAccountIfChanged(id: string, patch: { name?: string; description?: string; status?: 'active' | 'disabled' }): Promise<{
    before: ServiceAccount
    account: ServiceAccount
    changedFields: string[]
  } | null>
  listKeys(accountId: string): Promise<ServiceAccountKey[]>
  issueKey(input: {
    accountId: string
    name: string
    scopes: string[]
    namespaces: string[]
    expiresAt?: Date | null
    createdBy: string
  }): Promise<IssuedServiceAccountKey>
  revokeKey(accountId: string, keyId: string): Promise<boolean>
  authenticate(token: string): Promise<ServicePrincipal | null>
}

export function createServiceAccountStore(pool: Pool): ServiceAccountStore {
  return {
    async listAccounts() {
      const r = await pool.query<AccountRow>(
        `SELECT id, name, description, status, created_at, updated_at
           FROM service_accounts ORDER BY name`,
      )
      return r.rows.map(toAccount)
    },

    async getAccount(id) {
      const r = await pool.query<AccountRow>(
        `SELECT id, name, description, status, created_at, updated_at
           FROM service_accounts WHERE id = $1`,
        [id],
      )
      return r.rows[0] ? toAccount(r.rows[0]) : null
    },

    async createAccount(input) {
      const id = newId()
      const r = await pool.query<AccountRow>(
        `INSERT INTO service_accounts (id, name, description, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, status, created_at, updated_at`,
        [id, input.name.trim(), input.description?.trim() ?? '', input.createdBy],
      )
      return toAccount(r.rows[0])
    },

    async updateAccount(id, patch) {
      const fields: string[] = []
      const values: unknown[] = []
      if (patch.name !== undefined) {
        values.push(patch.name.trim())
        fields.push(`name = $${values.length}`)
      }
      if (patch.description !== undefined) {
        values.push(patch.description.trim())
        fields.push(`description = $${values.length}`)
      }
      if (patch.status !== undefined) {
        values.push(patch.status)
        fields.push(`status = $${values.length}`)
      }
      if (fields.length === 0) {
        const r = await pool.query<AccountRow>(
          `SELECT id, name, description, status, created_at, updated_at
             FROM service_accounts WHERE id = $1`,
          [id],
        )
        return r.rows[0] ? toAccount(r.rows[0]) : null
      }
      values.push(id)
      const r = await pool.query<AccountRow>(
        `UPDATE service_accounts SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${values.length}
          RETURNING id, name, description, status, created_at, updated_at`,
        values,
      )
      return r.rows[0] ? toAccount(r.rows[0]) : null
    },

    async updateAccountIfChanged(id, patch) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const current = await client.query<AccountRow>(
          `SELECT id, name, description, status, created_at, updated_at
             FROM service_accounts WHERE id = $1 FOR UPDATE`,
          [id],
        )
        if (!current.rows[0]) {
          await client.query('ROLLBACK')
          return null
        }
        const before = toAccount(current.rows[0])
        const normalized = {
          name: patch.name?.trim(),
          description: patch.description?.trim(),
          status: patch.status,
        }
        const changedFields = (Object.keys(normalized) as Array<keyof typeof normalized>)
          .filter(key => normalized[key] !== undefined && normalized[key] !== before[key])
        if (changedFields.length === 0) {
          await client.query('COMMIT')
          return { before, account: before, changedFields: [] }
        }
        const fields: string[] = []
        const values: unknown[] = []
        for (const key of changedFields) {
          values.push(normalized[key])
          fields.push(`${key} = $${values.length}`)
        }
        values.push(id)
        const updated = await client.query<AccountRow>(
          `UPDATE service_accounts SET ${fields.join(', ')}, updated_at = now()
            WHERE id = $${values.length}
            RETURNING id, name, description, status, created_at, updated_at`,
          values,
        )
        await client.query('COMMIT')
        return { before, account: toAccount(updated.rows[0]), changedFields }
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    async listKeys(accountId) {
      const r = await pool.query<KeyRow>(
        `${KEY_SELECT} WHERE k.service_account_id = $1 ORDER BY k.created_at DESC`,
        [accountId],
      )
      return r.rows.map(toKey)
    },

    async issueKey(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const id = newId()
        const publicId = id.replaceAll('-', '').slice(0, 16)
        const tokenPrefix = `mado_lin_${publicId}`
        const secret = randomToken(32)
        const r = await client.query<KeyRow>(
          `INSERT INTO service_account_keys
             (id, service_account_id, name, token_prefix, secret_hash, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, service_account_id, name, token_prefix, secret_hash,
                     created_at, expires_at, revoked_at, last_used_at,
                     ARRAY[]::text[] AS scopes, ARRAY[]::text[] AS namespaces`,
          [id, input.accountId, input.name.trim(), tokenPrefix, sha256(secret), input.createdBy, input.expiresAt ?? null],
        )
        for (const scope of [...new Set(input.scopes)]) {
          await client.query(
            `INSERT INTO service_account_key_scopes (key_id, scope) VALUES ($1, $2)`,
            [id, scope],
          )
        }
        for (const namespace of [...new Set(input.namespaces)]) {
          await client.query(
            `INSERT INTO service_account_key_namespaces (key_id, namespace) VALUES ($1, $2)`,
            [id, namespace],
          )
        }
        await client.query('COMMIT')
        const key = toKey({
          ...r.rows[0],
          scopes: [...new Set(input.scopes)].sort(),
          namespaces: [...new Set(input.namespaces)].sort(),
        })
        return { ...key, token: `${tokenPrefix}.${secret}` }
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    async revokeKey(accountId, keyId) {
      const r = await pool.query(
        `UPDATE service_account_keys SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1 AND service_account_id = $2 AND revoked_at IS NULL`,
        [keyId, accountId],
      )
      return (r.rowCount ?? 0) > 0
    },

    async authenticate(token) {
      const dot = token.indexOf('.')
      if (dot < 0 || dot !== token.lastIndexOf('.')) return null
      const prefix = token.slice(0, dot)
      const secret = token.slice(dot + 1)
      if (!/^mado_lin_[A-Za-z0-9_-]{8,32}$/.test(prefix) || secret.length < 32 || secret.length > 128) {
        return null
      }
      const r = await pool.query<KeyRow & {
        account_name: string
        account_status: 'active' | 'disabled'
      }>(
        `${KEY_SELECT.replace('FROM service_account_keys k', ', a.name AS account_name, a.status AS account_status\n    FROM service_account_keys k\n    JOIN service_accounts a ON a.id = k.service_account_id')}
          WHERE k.token_prefix = $1 AND k.revoked_at IS NULL
            AND (k.expires_at IS NULL OR k.expires_at > now())`,
        [prefix],
      )
      const row = r.rows[0]
      if (!row || row.account_status !== 'active' || !equalDigest(row.secret_hash, sha256(secret))) {
        return null
      }
      if (!row.last_used_at || Date.now() - row.last_used_at.getTime() >= 300_000) {
        void pool.query(
          `UPDATE service_account_keys SET last_used_at = now()
            WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
          [row.id],
        ).catch(e => console.error('failed to update service key last_used_at', e))
      }
      return {
        kind: 'service_account',
        serviceAccountId: row.service_account_id,
        serviceAccountName: row.account_name,
        keyId: row.id,
        scopes: row.scopes,
        namespaces: row.namespaces,
      }
    },
  }
}

const BEARER_RE = /^Bearer[ \t]+([^ \t]+)$/i

export function bearerToken(header: string | undefined): string | null {
  const match = BEARER_RE.exec(header ?? '')
  return match?.[1] ?? null
}
