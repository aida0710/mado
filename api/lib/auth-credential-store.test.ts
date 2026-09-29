import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createCredentialStore } from './auth-credential-store.js'
import { createAuditWriter } from './audit.js'
import { SessionUserUnavailableError, createSessionStore } from './auth-session-store.js'
import { createUserStore } from './auth-user-store.js'
import { hashPassword } from './password.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const sessions = createSessionStore(pools.rw, createAuditWriter(pools.rw))
const lifetime = { idleSeconds: 3600, absoluteSeconds: 7200 }

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

async function localUser(password = 'current-password-123') {
  const user = await users.createUser({
    username: 'local', email: 'local@example.com', displayName: 'Local', roles: ['viewer'],
    localPassword: { hash: await hashPassword(password), mustChange: false },
  })
  return (await credentials.getLocalCredential(user.id))!
}

describe('CredentialStore', () => {
  it('login の識別子は username でも email でも、大文字小文字を問わず引ける', async () => {
    const credential = await localUser()
    expect((await credentials.findLocalCredentialByLogin('LOCAL@example.com'))?.id).toBe(credential.id)
    expect((await credentials.findLocalCredentialByLogin('Local'))?.id).toBe(credential.id)
  })

  it('検証のあとでパスワードが変わっていたら、login の session を発行しない', async () => {
    const credential = await localUser()
    await credentials.resetLocalPassword(credential.id, await hashPassword('reset-password-123'))
    const session = await credentials.openLocalSession({
      userId: credential.id, verifiedPasswordHash: credential.passwordHash, session: { lifetime },
    })
    expect(session).toBeNull()
  })

  it('rehash は、検証に使った hash がまだ保存されているときだけ置き換える', async () => {
    const credential = await localUser()
    const rehashed = await hashPassword('current-password-123')
    const session = await credentials.openLocalSession({
      userId: credential.id, verifiedPasswordHash: credential.passwordHash,
      rehashedPasswordHash: rehashed, session: { lifetime },
    })
    expect(session).not.toBeNull()
    expect((await credentials.getLocalCredential(credential.id))?.passwordHash).toBe(rehashed)
  })

  it('パスワードを変えたら古い session をすべて失効させ、新しい session だけを残す', async () => {
    const credential = await localUser()
    const old = await sessions.createSession({ userId: credential.id, lifetime })
    const next = await credentials.changeLocalPassword({
      userId: credential.id, verifiedPasswordHash: credential.passwordHash,
      newPasswordHash: await hashPassword('changed-password-123'), session: { lifetime },
    })
    expect(next).not.toBeNull()
    expect(await sessions.authenticateSession(old.token, 3600)).toBeNull()
    expect(await sessions.authenticateSession(next!.token, 3600)).not.toBeNull()
  })

  it('同時にパスワードを変えられていたら、変更を上書きしない', async () => {
    const credential = await localUser()
    await credentials.resetLocalPassword(credential.id, await hashPassword('reset-password-123'))
    const next = await credentials.changeLocalPassword({
      userId: credential.id, verifiedPasswordHash: credential.passwordHash,
      newPasswordHash: await hashPassword('changed-password-123'), session: { lifetime },
    })
    expect(next).toBeNull()
    expect((await credentials.getLocalCredential(credential.id))?.mustChangePassword).toBe(true)
  })

  it('再発行は次回の変更を必須にし、session をすべて失効させる', async () => {
    const credential = await localUser()
    const session = await sessions.createSession({ userId: credential.id, lifetime })
    expect(await credentials.resetLocalPassword(credential.id, await hashPassword('reset-password-123'))).toBe(true)
    expect((await credentials.getLocalCredential(credential.id))?.mustChangePassword).toBe(true)
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
  })

  it('無効にした User には、パスワードが合っていても login の session を発行しない', async () => {
    const credential = await localUser()
    await users.updateUser(credential.id, { status: 'disabled' })
    const session = await credentials.openLocalSession({
      userId: credential.id, verifiedPasswordHash: credential.passwordHash, session: { lifetime },
    })
    expect(session).toBeNull()
  })

  it('管理者が同じ User の行をロックしている間のパスワード変更は、deadlock せずに待ってから進む', async () => {
    const credential = await localUser()
    await sessions.createSession({ userId: credential.id, lifetime })
    const admin = await pools.rw.connect()
    try {
      // 無効化・Role 変更と同じく、user 行 → session の順でロックする管理者側の transaction。
      await admin.query('BEGIN')
      await admin.query('SELECT id FROM auth_users WHERE id = $1 FOR UPDATE', [credential.id])
      const changing = credentials.changeLocalPassword({
        userId: credential.id, verifiedPasswordHash: credential.passwordHash,
        newPasswordHash: await hashPassword('changed-password-123'), session: { lifetime },
      })
      // pg_stat_activity は transaction の中では最初に読んだ内容を使い回すので、
      // 管理者側の transaction の外の接続から、パスワード変更がロック待ちに入ったことを見る。
      await vi.waitFor(async () => {
        const waiting = await pools.rw.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
        expect(waiting.rows[0].count).toBeGreaterThan(0)
      })
      await admin.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1', [credential.id])
      await admin.query('COMMIT')
      await expect(changing).resolves.not.toBeNull()
    } finally {
      await admin.query('ROLLBACK').catch(() => {})
      admin.release()
    }
  })
})

describe('SessionStore の発行条件', () => {
  it('無効にした User には session を発行しない', async () => {
    const user = await users.createUser({ email: 'u@example.com', displayName: 'U', roles: ['viewer'] })
    await users.updateUser(user.id, { status: 'disabled' })
    await expect(sessions.createSession({ userId: user.id, lifetime }))
      .rejects.toBeInstanceOf(SessionUserUnavailableError)
  })
})
