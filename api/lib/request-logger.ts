import type { MiddlewareHandler } from 'hono'

/** OAuth code/stateを含むquery stringを一切出さないrequest logger。 */
export function requestLogger(print: (message: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now()
    await next()
    const elapsed = Math.round(performance.now() - started)
    print(`${c.req.method} ${c.req.path} ${c.res.status} ${elapsed}ms`)
  }
}
