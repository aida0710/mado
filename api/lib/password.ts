import argon2 from 'argon2'

// OWASP Password Storage Cheat Sheet の Argon2id 最低推奨値。
// encoded hash 自体に parameter/salt が含まれるので、将来値を上げても旧hashを検証できる。
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

// パスワードの長さは UTF-8 の byte で数える。日本語 1 文字は 3 byte になるので、
// 入力検証も文字数ではなくこの関数で見る (文字数で見ると、検証を通ったのに hash で失敗する)。
export const PASSWORD_MIN_BYTES = 12
// Argon2 に極端に長い入力を渡させない上限。
export const PASSWORD_MAX_BYTES = 1024
// bootstrap は対話入力で、初回 login で変更を必須にするので短めを許す。
const BOOTSTRAP_PASSWORD_MIN_BYTES = 8

export function isAcceptablePasswordLength(password: string, minimumBytes = PASSWORD_MIN_BYTES): boolean {
  const bytes = Buffer.byteLength(password, 'utf8')
  return bytes >= minimumBytes && bytes <= PASSWORD_MAX_BYTES
}

async function hashWithMinimum(password: string, minimumBytes: number): Promise<string> {
  if (!isAcceptablePasswordLength(password, minimumBytes)) {
    throw new Error(`password must be ${minimumBytes}-${PASSWORD_MAX_BYTES} bytes`)
  }
  return argon2.hash(password, PASSWORD_HASH_OPTIONS)
}

export async function hashPassword(password: string): Promise<string> {
  return hashWithMinimum(password, PASSWORD_MIN_BYTES)
}

export async function hashBootstrapPassword(password: string): Promise<string> {
  return hashWithMinimum(password, BOOTSTRAP_PASSWORD_MIN_BYTES)
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
