import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { requireWriteToken } from './auth.js'

const app = new Hono()
app.post('/secure', requireWriteToken('SECRET'), c => c.text('ok'))

describe('requireWriteToken', () => {
  it('rejects no header with 401', async () => {
    const res = await app.request('/secure', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects wrong token with 401', async () => {
    const res = await app.request('/secure', {
      method: 'POST',
      headers: { Authorization: 'Bearer NOPE' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects malformed Bearer line with 401', async () => {
    const res = await app.request('/secure', {
      method: 'POST',
      headers: { Authorization: 'NotBearer SECRET' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts correct token', async () => {
    const res = await app.request('/secure', {
      method: 'POST',
      headers: { Authorization: 'Bearer SECRET' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
