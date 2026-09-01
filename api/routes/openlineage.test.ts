import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { RegistryClient } from '../lib/registry-client.js'
import {
  OPENLINEAGE_INGEST_PATH,
  mountOpenLineageRoutes,
  type LineageServiceAuthenticator,
} from './openlineage.js'

function event() {
  return {
    eventTime: '2026-08-26T00:00:00Z', eventType: 'COMPLETE',
    run: { runId: '5ee8b5a8-d32d-47f0-b119-5449286a6401', facets: {} },
    job: { namespace: 'speech', name: 'curate', facets: {} },
    inputs: [{
      namespace: 'shared', name: 'raw',
      facets: { version: { datasetVersion: 'raw-v1' } },
    }],
    outputs: [{
      namespace: 'speech', name: 'clean',
      facets: { version: { datasetVersion: 'clean-v1' } },
    }],
    producer: 'https://example.test', schemaURL: 'https://example.test/schema',
  }
}

function registry(): RegistryClient {
  return {
    ingestOpenLineage: vi.fn().mockResolvedValue({
      accepted: true, duplicate: false, eventId: 'evt-1',
      runId: event().run.runId, projection: 'pending', warnings: [],
    }),
    resolveDatasets: vi.fn(), searchDatasets: vi.fn(), resolveStorageLocation: vi.fn(), getDataset: vi.fn(),
    getVersion: vi.fn(), getRun: vi.fn(), getVersionGraph: vi.fn(),
    getProjectionStatus: vi.fn(),
  }
}

function auth(overrides: Partial<LineageServiceAuthenticator> = {}): LineageServiceAuthenticator {
  return {
    authenticate: vi.fn().mockResolvedValue({
      serviceAccountId: 'sa-1', keyId: 'key-1',
      scopes: ['lineage:write'], namespaces: ['speech'],
    }),
    recordUse: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function request(body: unknown, token = 'mado_lin_key.secret'): Request {
  return new Request(`http://mado${OPENLINEAGE_INGEST_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('OpenLineage ingest route', () => {
  it('Bearerなしを拒否する', async () => {
    const recordUse = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    mountOpenLineageRoutes(app, { auth: auth({ recordUse }), registry: registry() })
    const res = await app.request(OPENLINEAGE_INGEST_PATH, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(recordUse).not.toHaveBeenCalled()
  })

  it('無効なkeyは拒否するが変更監査を作らない', async () => {
    const recordUse = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    mountOpenLineageRoutes(app, {
      auth: auth({ authenticate: vi.fn().mockResolvedValue(null), recordUse }),
      registry: registry(),
    })
    const response = await app.request(request(event(), 'mado_lin_abcdefgh12345678.super-secret'))
    expect(response.status).toBe(401)
    expect(recordUse).not.toHaveBeenCalled()
  })

  it('Originなしでもservice keyで受け、Registryへだけwriteする', async () => {
    const reg = registry()
    const recordUse = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    mountOpenLineageRoutes(app, { auth: auth({ recordUse }), registry: reg })
    const res = await app.request(request(event()))
    expect(res.status).toBe(200)
    expect(reg.ingestOpenLineage).toHaveBeenCalledTimes(1)
    const [, principal] = vi.mocked(reg.ingestOpenLineage).mock.calls[0]
    expect(principal).toEqual({
      serviceAccountId: 'sa-1', keyId: 'key-1', allowedNamespaces: ['speech'],
    })
    expect(recordUse).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted' }))
  })

  it('重複eventはRegistryへ送るが変更監査を作らない', async () => {
    const reg = registry()
    vi.mocked(reg.ingestOpenLineage).mockResolvedValue({
      accepted: true, duplicate: true, eventId: 'evt-1',
      runId: event().run.runId, projection: 'synced', warnings: [],
    })
    const recordUse = vi.fn().mockResolvedValue(undefined)
    const app = new Hono()
    mountOpenLineageRoutes(app, { auth: auth({ recordUse }), registry: reg })
    expect((await app.request(request(event()))).status).toBe(200)
    expect(recordUse).not.toHaveBeenCalled()
  })

  it('lineage:write scopeなしを拒否する', async () => {
    const reg = registry()
    const app = new Hono()
    mountOpenLineageRoutes(app, {
      auth: auth({ authenticate: vi.fn().mockResolvedValue({
        serviceAccountId: 'sa', keyId: 'key', scopes: [], namespaces: ['speech'],
      }) }),
      registry: reg,
    })
    expect((await app.request(request(event()))).status).toBe(403)
    expect(reg.ingestOpenLineage).not.toHaveBeenCalled()
  })

  it('job/output namespace違反をRegistry送信前に拒否する', async () => {
    const reg = registry()
    const app = new Hono()
    mountOpenLineageRoutes(app, {
      auth: auth({ authenticate: vi.fn().mockResolvedValue({
        serviceAccountId: 'sa', keyId: 'key', scopes: ['lineage:write'], namespaces: ['other'],
      }) }),
      registry: reg,
    })
    const res = await app.request(request(event()))
    expect(res.status).toBe(403)
    expect(reg.ingestOpenLineage).not.toHaveBeenCalled()
  })

  it('version identityのないeventを拒否する', async () => {
    const value = event()
    value.inputs[0].facets = {}
    const app = new Hono()
    mountOpenLineageRoutes(app, { auth: auth(), registry: registry() })
    const res = await app.request(request(value))
    expect(res.status).toBe(422)
  })

  it('実測body sizeが上限を超えたら拒否する', async () => {
    const reg = registry()
    const app = new Hono()
    mountOpenLineageRoutes(app, { auth: auth(), registry: reg, bodyLimitBytes: 16 })
    const res = await app.request(request(event()))
    expect(res.status).toBe(413)
    expect(reg.ingestOpenLineage).not.toHaveBeenCalled()
  })
})
