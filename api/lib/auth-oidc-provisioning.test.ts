import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter, type AuditWriter } from './audit.js'
import { createCredentialStore } from './auth-credential-store.js'
import {
  OidcLoginDeniedError, createOidcProvisioning, resolveOidcRoles, type OidcProvisionInput,
} from './auth-oidc-provisioning.js'
import { createUserStore } from './auth-user-store.js'
import { hashPassword } from './password.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const provisioning = createOidcProvisioning(pools.rw, audit)

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('resolveOidcRoles', () => {
  const policy = {
    allowedGroups: ['mado-users', 'mado-admins'],
    roleMapping: { 'mado-admins': 'admin' as const },
    defaultRole: 'viewer' as const,
  }

  it('許可された group に 1 つも入っていなければ login させない', () => {
    expect(resolveOidcRoles(policy, ['others'])).toEqual({ allowed: false })
    expect(resolveOidcRoles({ ...policy, allowedGroups: [] }, ['mado-users'])).toEqual({ allowed: false })
  })

  it('対応表にある group から Role を決め、無ければ既定の Role にする', () => {
    expect(resolveOidcRoles(policy, ['mado-users', 'mado-admins'])).toEqual({ allowed: true, managedRoles: ['admin'] })
    expect(resolveOidcRoles(policy, ['mado-users'])).toEqual({ allowed: true, managedRoles: ['viewer'] })
  })

  it('対応表が空なら Role は Mado 側の管理に任せる', () => {
    expect(resolveOidcRoles({ ...policy, roleMapping: {} }, ['mado-users'])).toEqual({ allowed: true })
  })
})

describe('OidcProvisioning', () => {
  const issuer = 'https://auth.example/application/o/mado'

  it('検証済み email だけを既存の Local User へ連携し、group の Role を同期する', async () => {
    const local = await users.createUser({
      username: 'local', email: 'same@example.com', displayName: 'Local', roles: ['viewer'],
      localPassword: { hash: await hashPassword('long-enough-password'), mustChange: false },
    })
    const linked = await provisioning.provisionOidcUser({
      issuer, subject: 'verified-subject',
      email: 'same@example.com', emailVerified: true, username: 'from-sso', displayName: 'SSO Name',
      groups: ['mado-admins'], autoLinkVerifiedEmail: true, defaultRole: 'viewer', managedRoles: ['admin'],
    })
    expect(linked).toMatchObject({ created: false, linkedExisting: true })
    expect(linked.user).toMatchObject({ id: local.id, username: 'local', roles: ['admin'] })
    expect(linked.user.authMethods).toEqual(['local', 'sso'])

    const unverified = await provisioning.provisionOidcUser({
      issuer, subject: 'unverified-subject',
      email: 'same@example.com', emailVerified: false, username: 'new-sso', displayName: 'Other',
      groups: [], autoLinkVerifiedEmail: true, defaultRole: 'viewer',
    })
    expect(unverified).toMatchObject({ created: true, linkedExisting: false })
    expect(unverified.user.id).not.toBe(local.id)
    expect(unverified.user.email).toBeNull()
    expect((await credentials.findLocalCredentialByLogin('local'))?.roles).toEqual(['admin'])
  })

  it('特権を持つ Local User への email の自動連携は断る', async () => {
    await users.createUser({ username: 'admin', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
    const denied = provisioning.provisionOidcUser({
      issuer, subject: 'attacker-subject',
      email: 'admin@example.com', emailVerified: true, username: 'attacker', displayName: 'Attacker',
      groups: ['mado-users'], autoLinkVerifiedEmail: true, defaultRole: 'viewer',
    })
    await expect(denied).rejects.toBeInstanceOf(OidcLoginDeniedError)
    await expect(denied).rejects.toMatchObject({ reason: 'privileged_link_required' })
  })

  it('group の Role 同期で、最後の active な Admin を降格しない', async () => {
    const input: OidcProvisionInput = {
      issuer, subject: 'admin-subject', email: 'sso-admin@example.com', emailVerified: true,
      username: 'sso-admin', displayName: 'SSO Admin', groups: ['mado-admins'],
      autoLinkVerifiedEmail: false, defaultRole: 'viewer', managedRoles: ['admin'],
    }
    const provisioned = await provisioning.provisionOidcUser(input)
    await expect(provisioning.provisionOidcUser({ ...input, groups: ['mado-users'], managedRoles: ['viewer'] }))
      .rejects.toMatchObject({ reason: 'last_admin' })
    expect((await users.getUser(provisioned.user.id))?.roles).toEqual(['admin'])

    await users.createUser({ email: 'break-glass@example.com', displayName: 'Break Glass', roles: ['admin'] })
    const demoted = await provisioning.provisionOidcUser({ ...input, groups: ['mado-users'], managedRoles: ['viewer'] })
    expect(demoted.user.roles).toEqual(['viewer'])
  })

  it('Role の同期を、同期と同じ transaction で監査に残す', async () => {
    const provisioned = await provisioning.provisionOidcUser({
      issuer, subject: 'new-subject', email: null, emailVerified: false, username: 'new', displayName: 'New',
      groups: ['mado-admins'], autoLinkVerifiedEmail: false, defaultRole: 'viewer', managedRoles: ['admin'],
      metadata: { ipAddress: '10.0.0.1' },
    })
    const events = await pools.rw.query<{ actor_user_id: string; details: { rolesAfter: string[] } }>(
      `SELECT actor_user_id, details FROM audit_events WHERE action = 'auth.oidc.sync'`,
    )
    expect(events.rows).toEqual([expect.objectContaining({
      actor_user_id: provisioned.user.id, details: expect.objectContaining({ rolesAfter: ['admin'] }),
    })])
  })

  it('監査を書けなければ、Role の同期も残さない', async () => {
    const failingAudit = { ...audit, write: () => Promise.reject(new Error('audit unavailable')) } as AuditWriter
    await expect(createOidcProvisioning(pools.rw, failingAudit).provisionOidcUser({
      issuer, subject: 'unaudited-subject', email: null, emailVerified: false, username: 'unaudited',
      displayName: 'Unaudited', groups: ['mado-admins'], autoLinkVerifiedEmail: false,
      defaultRole: 'viewer', managedRoles: ['admin'],
    })).rejects.toThrow('audit unavailable')
    expect(await credentials.findLocalCredentialByLogin('unaudited')).toBeNull()
    expect((await users.listUsers()).map(user => user.username)).not.toContain('unaudited')
  })
})
