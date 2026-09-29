import { stdin, stdout } from 'node:process'
import { createPools, closePools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createUserStore } from '../lib/auth-user-store.js'
import { createCredentialStore } from '../lib/auth-credential-store.js'
import { hashBootstrapPassword } from '../lib/password.js'

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function hiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new Error('password input requires a TTY; run this command with docker compose exec (without -T)')
  }
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('interrupted'))
          return
        }
        if (char === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        if (char >= ' ') value += char
      }
    }
    stdin.on('data', onData)
  })
}

const username = option('--username')?.trim().toLowerCase() || 'admin'
const email = option('--email')?.trim().toLowerCase() || null
const displayName = option('--name')?.trim() || 'Mado Administrator'
const databaseUrl = process.env.DATABASE_URL_RW
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(username)) {
  throw new Error('username must use letters, numbers, dot, underscore, or hyphen')
}
if (email && !email.includes('@')) throw new Error('email must be valid')
if (!databaseUrl) throw new Error('DATABASE_URL_RW is required')

const first = await hiddenPassword('New admin password: ')
const second = await hiddenPassword('Confirm password: ')
if (first !== second) throw new Error('passwords do not match')
const passwordHash = await hashBootstrapPassword(first)

const pools = createPools({ rw: databaseUrl, ro: process.env.DATABASE_URL_RO ?? databaseUrl })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const audit = createAuditWriter(pools.rw)
try {
  const credential = await credentials.findLocalCredentialByLogin(username)
  let user = credential ?? (await users.listUsers()).find(u => u.username?.toLowerCase() === username)
  if (!user) {
    user = await users.createUser({ username, email, displayName, roles: ['admin'] })
  } else if (!user.roles.includes('admin')) {
    user = (await users.replaceUserRoles(user.id, [...user.roles, 'admin'], user.id))?.user ?? user
  }
  if (user.status !== 'active') {
    user = (await users.updateUser(user.id, { status: 'active' }))?.user ?? user
  }
  // 次回の login でパスワードの変更を必須にし、既存の session はすべて失効させる。
  await credentials.resetLocalPassword(user.id, passwordHash)
  await audit.write({
    actor: { type: 'system' }, action: 'auth.bootstrap_admin', outcome: 'success',
    resourceType: 'user', resourceId: user.id, details: { username, email },
  })
  stdout.write(`Admin ready: ${username} (${user.id}); password change required\n`)
} finally {
  await closePools(pools)
}
