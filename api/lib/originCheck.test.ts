import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { requireSafeOrigin } from './originCheck.js'

const ALLOWED = ['http://localhost:5173', 'http://lab-server']

function makeApp() {
  const app = new Hono()
  app.use('*', requireSafeOrigin(ALLOWED))
  app.get('/x', c => c.text('ok'))
  app.post('/x', c => c.text('ok'))
  app.put('/x', c => c.text('ok'))
  app.delete('/x', c => c.text('ok'))
  return app
}

describe('requireSafeOrigin', () => {
  it('GET は Origin が無くても通す', async () => {
    const app = makeApp()
    const res = await app.request('/x', { method: 'GET' })
    expect(res.status).toBe(200)
  })

  it('HEAD / OPTIONS も素通し', async () => {
    const app = makeApp()
    const head = await app.request('/x', { method: 'HEAD' })
    expect(head.status).toBe(200)
    const options = await app.request('/x', { method: 'OPTIONS' })
    // Hono は明示登録のない OPTIONS に対して 404 を返すが、middleware は通る
    // = next() が呼ばれた、ということを確認したい
    expect([200, 404]).toContain(options.status)
  })

  it.each(['POST', 'PUT', 'DELETE'])('%s は Origin 一致で通す', async method => {
    const app = makeApp()
    const res = await app.request('/x', {
      method,
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
  })

  it.each(['POST', 'PUT', 'DELETE'])('%s は Origin 不一致で 403', async method => {
    const app = makeApp()
    const res = await app.request('/x', {
      method,
      headers: { Origin: 'http://attacker.example.com' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'invalid origin' })
  })

  it('Origin が無くても Referer が一致すれば通す', async () => {
    const app = makeApp()
    const res = await app.request('/x', {
      method: 'POST',
      headers: { Referer: 'http://localhost:5173/some/path' },
    })
    expect(res.status).toBe(200)
  })

  it('Origin も Referer も無い書き込みは 403', async () => {
    const app = makeApp()
    const res = await app.request('/x', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('複数の allowed origin の 2 つ目とも一致する', async () => {
    const app = makeApp()
    const res = await app.request('/x', {
      method: 'POST',
      headers: { Origin: 'http://lab-server' },
    })
    expect(res.status).toBe(200)
  })

  it('部分一致 (prefix) で誤許可しない', async () => {
    const app = makeApp()
    // "http://localhost:5173" を許可するが、"http://localhost:51735" は別 origin
    const res = await app.request('/x', {
      method: 'POST',
      headers: { Origin: 'http://localhost:51735' },
    })
    expect(res.status).toBe(403)
  })
})
