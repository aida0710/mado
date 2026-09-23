import type { Context, MiddlewareHandler } from 'hono'
import { bearerToken } from './auth-api-keys.js'
import type { ServiceKeyScope } from './auth-types.js'

/** scope判定に要る部分だけを要求する。呼び出し側はより詳しいprincipal型を渡してよい。 */
export interface ScopedServicePrincipal {
  scopes: readonly string[]
}

export interface RequireServiceKeyScopeOptions<P extends ScopedServicePrincipal> {
  authenticate(token: string): Promise<P | null>
  scope: ServiceKeyScope
}

const SERVICE_PRINCIPAL_KEY = 'madoServicePrincipal'

/** browser sessionではなく、Service Account keyのBearer送信とscopeを要求する。 */
export function requireServiceKeyScope<P extends ScopedServicePrincipal>(
  options: RequireServiceKeyScopeOptions<P>,
): MiddlewareHandler {
  return async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'))
    if (!token) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'Bearer service key is required' }, 401)
    }

    let principal: P | null
    try {
      principal = await options.authenticate(token)
    } catch {
      return c.json({ error: 'authentication service unavailable' }, 503)
    }
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'invalid service key' }, 401)
    }
    if (!principal.scopes.includes(options.scope)) {
      return c.json({ error: `${options.scope} scope is required` }, 403)
    }
    c.set(SERVICE_PRINCIPAL_KEY, principal)
    await next()
  }
}

/** requireServiceKeyScopeを通過したhandlerの中でだけ呼ぶ。 */
export function getServiceKeyPrincipal<P extends ScopedServicePrincipal>(c: Context): P {
  const principal = c.get(SERVICE_PRINCIPAL_KEY) as P | undefined
  if (!principal) throw new Error('service key principal is missing; mount requireServiceKeyScope first')
  return principal
}
