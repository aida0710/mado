import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  getServiceKeyPrincipal, requireServiceKeyScope, type ScopedServicePrincipal,
} from './service-key-auth.js'

interface TestPrincipal extends ScopedServicePrincipal {
  keyId: string
}

function appWith(authenticate: (token: string) => Promise<TestPrincipal | null>): Hono {
  const app = new Hono()
  app.get('/protected', requireServiceKeyScope({ authenticate, scope: 'metrics:read' }), c =>
    c.text(getServiceKeyPrincipal<TestPrincipal>(c).keyId))
  return app
}

const bearer = { Authorization: 'Bearer mado_lin_key.secret' }

describe('requireServiceKeyScope', () => {
  it('Bearerなしは認証を呼ばずに401とWWW-Authenticateを返す', async () => {
    const authenticate = vi.fn()
    const response = await appWith(authenticate).request('/protected')
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('無効なkeyは401を返す', async () => {
    const response = await appWith(async () => null).request('/protected', { headers: bearer })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid service key' })
  })

  it('認証の問い合わせが失敗したら503を返す', async () => {
    const response = await appWith(async () => { throw new Error('db down') })
      .request('/protected', { headers: bearer })
    expect(response.status).toBe(503)
  })

  it('必要なscopeがないkeyは403を返す', async () => {
    const response = await appWith(async () => ({ keyId: 'key-1', scopes: ['lineage:write'] }))
      .request('/protected', { headers: bearer })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'metrics:read scope is required' })
  })

  it('scopeを持つkeyはhandlerへ認証済みprincipalを渡す', async () => {
    const authenticate = vi.fn().mockResolvedValue({ keyId: 'key-1', scopes: ['metrics:read'] })
    const response = await appWith(authenticate).request('/protected', { headers: bearer })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('key-1')
    expect(authenticate).toHaveBeenCalledWith('mado_lin_key.secret')
  })
})
