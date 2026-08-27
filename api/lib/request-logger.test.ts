import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { requestLogger } from './request-logger.js'

describe('requestLogger', () => {
  it('OIDC callbackのqueryを記録しない', async () => {
    const print = vi.fn()
    const app = new Hono()
    app.use('*', requestLogger(print))
    app.get('/api/auth/oidc/callback', c => c.text('ok'))
    await app.request('/api/auth/oidc/callback?code=secret-code&state=secret-state')
    expect(print).toHaveBeenCalledWith(expect.stringContaining('GET /api/auth/oidc/callback 200'))
    expect(print.mock.calls[0][0]).not.toContain('secret-code')
    expect(print.mock.calls[0][0]).not.toContain('secret-state')
  })
})
