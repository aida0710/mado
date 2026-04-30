import type { MiddlewareHandler } from 'hono'

const BEARER_RE = /^Bearer\s+(.+)$/

export function requireWriteToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? ''
    const match = BEARER_RE.exec(auth)
    if (!match || match[1] !== token) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}
