import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

const BEARER_RE = /^Bearer\s+(.+)$/

export function requireWriteToken(token: string): MiddlewareHandler {
  // クロージャ越しに 1 度だけ Buffer 化してホットパスのアロケーションを抑える。
  const expected = Buffer.from(token)
  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? ''
    const match = BEARER_RE.exec(auth)
    if (!match) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const provided = Buffer.from(match[1])
    // 長さが違う場合は timingSafeEqual に渡せない (throw する) ので先に弾く。
    // 長さ自体はタイミング攻撃で漏れるが token 長 (32 byte hex = 64 char) は固定値なので問題なし。
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}
