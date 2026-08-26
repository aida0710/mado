import argon2 from 'argon2'

// OWASP Password Storage Cheat Sheet の Argon2id 最低推奨値。
// encoded hash 自体に parameter/salt が含まれるので、将来値を上げても旧hashを検証できる。
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

async function hashWithMinimum(password: string, minimumBytes: number): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') < minimumBytes) {
    throw new Error(`password must be at least ${minimumBytes} bytes`)
  }
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('password must be at most 1024 bytes')
  }
  return argon2.hash(password, PASSWORD_HASH_OPTIONS)
}

export async function hashPassword(password: string): Promise<string> {
  return hashWithMinimum(password, 12)
}

// A known bootstrap credential is allowed to be shorter only because the
// account is forced through password change before the application is usable.
export async function hashBootstrapPassword(password: string): Promise<string> {
  return hashWithMinimum(password, 8)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    // parameter/saltはencoded hash側に含まれる。verify optionへhash optionは渡さない。
    return await argon2.verify(hash, password)
  } catch {
    // DB破損やargon2以外の文字列を認証エラーへ畳む。raw errorは利用者へ返さない。
    return false
  }
}

export function passwordNeedsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, PASSWORD_HASH_OPTIONS)
  } catch {
    return true
  }
}
