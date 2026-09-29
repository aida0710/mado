import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { mountStorageCapabilityGuards } from './storage-capability-routes.js'
import type { Capabilities, ConnectionConfig } from '../storage.js'

const ALL_ON: Capabilities = {
  list: true, preview: true, download: true, archive: true,
  audioInfo: true, audioSpectrogram: true, readmeRead: true, readmeWrite: true,
}

function appWith(capabilities: Partial<Capabilities>) {
  const app = new Hono()
  mountStorageCapabilityGuards(app, async () => ({
    listObjectsVersion: 'v2',
    capabilities: { ...ALL_ON, ...capabilities },
  } as ConnectionConfig))
  app.post('/storage/:connectionId/scan', c => c.json({ jobId: 'job-1' }, 202))
  app.get('/storage/:connectionId/readme', c => c.json({ exists: false }))
  app.put('/storage/:connectionId/readme', c => c.json({ ok: true }))
  return app
}

describe('mountStorageCapabilityGuards', () => {
  it('一覧を無効にした接続では、ディレクトリ走査も 403 で止める', async () => {
    const res = await appWith({ list: false }).request('/storage/abc/scan?bucket=b', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ capability: 'list' })
  })

  it('一覧が有効なら走査を受け付ける', async () => {
    const res = await appWith({}).request('/storage/abc/scan?bucket=b', { method: 'POST' })
    expect(res.status).toBe(202)
  })

  it('README は読み込みと編集で別の権限を見る', async () => {
    const app = appWith({ readmeWrite: false })
    expect((await app.request('/storage/abc/readme?bucket=b')).status).toBe(200)
    expect((await app.request('/storage/abc/readme?bucket=b', { method: 'PUT' })).status).toBe(403)
  })
})
