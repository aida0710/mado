import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { requireCapability } from './capabilityGuard.js'
import { ConnectionNotFoundError, type Capabilities, type ConnectionConfig } from '../storage.js'

const ALL_ON: Capabilities = {
  list: true, preview: true, download: true, archive: true,
  audioInfo: true, audioSpectrogram: true, readmeRead: true, readmeWrite: true,
}

function appWith(caps: Partial<Capabilities>, opts: { missing?: boolean } = {}) {
  const getConnectionConfig = (connId: string): Promise<ConnectionConfig> => {
    if (opts.missing) return Promise.reject(new ConnectionNotFoundError(connId))
    return Promise.resolve({
      listObjectsVersion: 'v2',
      capabilities: { ...ALL_ON, ...caps },
    })
  }
  const app = new Hono()
  app.use('/storage/:connId/preview/raw', requireCapability('download', getConnectionConfig))
  app.on('GET', '/storage/:connId/readme', requireCapability('readmeRead', getConnectionConfig))
  app.on('PUT', '/storage/:connId/readme', requireCapability('readmeWrite', getConnectionConfig))
  app.get('/storage/:connId/preview/raw', c => c.text('bytes'))
  app.get('/storage/:connId/readme', c => c.json({ exists: false }))
  app.put('/storage/:connId/readme', c => c.json({ ok: true }))
  return app
}

describe('requireCapability', () => {
  it('権限が有効ならハンドラまで通す', async () => {
    const res = await appWith({}).request('/storage/abc/preview/raw?bucket=b&key=k')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('bytes')
  })

  it('権限が無効なら 403 で止め、ハンドラを実行しない', async () => {
    const res = await appWith({ download: false }).request('/storage/abc/preview/raw?bucket=b&key=k')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; capability: string }
    expect(body.capability).toBe('download')
    // 共有 Web URL を直に開いた人にも理由が分かるよう、権限名を含める。
    expect(body.error).toContain('ダウンロード')
  })

  it('接続が存在しなければ 404 (403 ではなく)', async () => {
    const res = await appWith({}, { missing: true }).request('/storage/nope/preview/raw?bucket=b&key=k')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'connection not found' })
  })

  it('README は GET と PUT で別々の権限を見る', async () => {
    // 読み込みのみ許可: GET は通り、PUT は 403。
    const readOnly = appWith({ readmeWrite: false })
    expect((await readOnly.request('/storage/abc/readme?bucket=b')).status).toBe(200)
    const put = await readOnly.request('/storage/abc/readme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: '', body: 'x', editor: 'e' }),
    })
    expect(put.status).toBe(403)
    expect(((await put.json()) as { capability: string }).capability).toBe('readmeWrite')
  })

  it('読み込みが無効なら GET も 403', async () => {
    const res = await appWith({ readmeRead: false }).request('/storage/abc/readme?bucket=b')
    expect(res.status).toBe(403)
  })
})
