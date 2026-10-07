import { afterAll, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'

const RW = process.env.DATABASE_URL_RW_TEST ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
afterAll(() => closePools(pools))

describe('workerのDB権限', () => {
  it('ストレージ設定を読み、解析と容量計測の表を書ける', async () => {
    const readable = ['storage_connections', 'connection_settings']
    for (const table of readable) {
      const row = await pools.ro.query("SELECT has_table_privilege('mado_worker', $1, 'SELECT') AS allowed", [table])
      expect(row.rows[0].allowed).toBe(true)
    }
    for (const table of ['media_cache', 'jobs', 'pricing_cache', 'storage_capacity_snapshots', 'storage_capacity_prefix_snapshots']) {
      const row = await pools.ro.query("SELECT has_table_privilege('mado_worker', $1, 'INSERT,UPDATE,DELETE') AS allowed", [table])
      expect(row.rows[0].allowed).toBe(true)
    }
  })

  it('認証・権限・service keyを読めず、API roleの権限も引き継がない', async () => {
    for (const table of ['auth_sessions', 'auth_local_credentials', 'auth_users', 'auth_user_roles', 'service_account_keys', 'audit_events']) {
      const row = await pools.ro.query("SELECT has_table_privilege('mado_worker', $1, 'SELECT,INSERT,UPDATE,DELETE') AS allowed", [table])
      expect(row.rows[0].allowed).toBe(false)
    }
    const role = await pools.ro.query("SELECT pg_has_role('mado_worker', 'dashboard_rw', 'MEMBER') AS api_member, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'mado_worker'")
    expect(role.rows[0]).toEqual({ api_member: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false })
  })
})
