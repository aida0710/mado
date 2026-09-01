import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AuditWriter } from '../lib/audit.js'
import type { RegistryClient } from '../lib/registry-client.js'
import { setSessionPrincipal } from '../lib/rbac.js'
import { mountLineageCurationRoutes } from './lineage-curation.js'

const user = {
  id: '00000000-0000-4000-8000-000000000001', username: 'curator', email: null,
  displayName: 'Curator', signatureName: 'Curator', status: 'active' as const,
  roles: ['curator'], permissions: ['storage:read', 'lineage:read', 'lineage:curate'],
  mustChangePassword: false, authMethods: ['local' as const],
}

function appWith(registryOverrides: Partial<RegistryClient> = {}) {
  const registry = {
    getDataset: vi.fn().mockResolvedValue({
      datasetId: '00000000-0000-4000-8000-000000000010',
      namespace: 'speech', name: 'raw', displayName: '更新前', aliases: [],
      description: null, mediaType: null, owner: null, currentVersionId: null,
      versionCount: 0, createdAt: '2026-08-31T00:00:00Z', versions: [], kind: 'dataset', datasetKey: 'raw',
    }),
    updateDataset: vi.fn().mockResolvedValue({
      datasetId: '00000000-0000-4000-8000-000000000010',
      namespace: 'speech', name: 'raw', displayName: '更新後', aliases: [],
      description: null, mediaType: null, owner: null, currentVersionId: null,
      versionCount: 0, createdAt: '2026-08-31T00:00:00Z', versions: [], kind: 'dataset', datasetKey: 'raw',
    }),
    registerManualDataset: vi.fn().mockResolvedValue({
      dataset: { dataset_id: '00000000-0000-4000-8000-000000000010' },
      version: { id: '00000000-0000-4000-8000-000000000011' },
    }),
    registerManualLocation: vi.fn().mockResolvedValue({}),
    registerManualLineage: vi.fn().mockResolvedValue({}),
    ...registryOverrides,
  } as unknown as RegistryClient
  const pool = { query: vi.fn().mockResolvedValue({ rows: [{
    registry_storage_system_key: 'mdx-s3', endpoint: 'https://s3.example.test', region: 'jp1',
  }] }) }
  const audit = { write: vi.fn().mockResolvedValue(undefined) } as unknown as AuditWriter
  const app = new Hono()
  app.use('*', async (c, next) => {
    setSessionPrincipal(c, { kind: 'user', sessionId: 'session', user })
    await next()
  })
  mountLineageCurationRoutes(app, { registry, pool: pool as never, audit })
  return { app, registry, pool, audit }
}

describe('lineage curation routes', () => {
  it('Datasetの説明情報だけを更新して変更項目を監査する', async () => {
    const { app, registry, audit } = appWith()
    const datasetId = '00000000-0000-4000-8000-000000000010'
    const res = await app.request(`/lineage/curation/datasets/${datasetId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '更新後', aliases: ['speech'] }),
    })

    expect(res.status).toBe(200)
    expect(registry.updateDataset).toHaveBeenCalledWith(datasetId, {
      displayName: '更新後', aliases: ['speech'],
    })
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'lineage.dataset.update', resourceId: datasetId,
      details: { changedFields: ['displayName', 'aliases'] },
    }))
  })

  it('Datasetの同値更新はRegistry変更と監査を行わない', async () => {
    const { app, registry, audit } = appWith()
    const datasetId = '00000000-0000-4000-8000-000000000010'
    const res = await app.request(`/lineage/curation/datasets/${datasetId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '更新前', aliases: [] }),
    })
    expect(res.status).toBe(200)
    expect(registry.updateDataset).not.toHaveBeenCalled()
    expect(audit.write).not.toHaveBeenCalled()
  })

  it('Mado接続をRegistryの保存場所へ変換してDatasetを登録する', async () => {
    const { app, registry, audit } = appWith()
    const res = await app.request('/lineage/curation/datasets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: {
          datasetKey: 'speech/raw', namespace: 'speech', name: 'raw', displayName: '音声原本', aliases: [],
        },
        version: { version: 'v1' },
        location: {
          connectionId: 'conn-1', bucket: 'dataset', key: 'raw/', status: 'available', isPrimary: true,
        },
        evidenceRefs: ['https://example.test/readme'],
      }),
    })

    expect(res.status).toBe(201)
    expect(registry.registerManualDataset).toHaveBeenCalledWith(expect.objectContaining({
      dataset: expect.objectContaining({ namespace: 'speech', name: 'raw' }),
      locations: [expect.objectContaining({
        uri: 's3://dataset/raw/', storage_system_key: 'mdx-s3', storage_endpoint: 'https://s3.example.test',
      })],
      submitted_by: user.id,
    }))
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
      action: 'lineage.dataset.register', outcome: 'success',
      details: expect.objectContaining({ storageUri: 's3://dataset/raw/' }),
    }))
  })

  it('同じVersionを入出力にした処理履歴を拒否する', async () => {
    const { app, registry } = appWith()
    const versionId = '00000000-0000-4000-8000-000000000011'
    const res = await app.request('/lineage/curation/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transformation: { transformationKey: 'copy', name: 'Copy' },
        inputVersionIds: [versionId], outputVersionIds: [versionId],
        jobNamespace: 'speech', jobName: 'copy', evidenceRefs: [],
      }),
    })
    expect(res.status).toBe(400)
    expect(registry.registerManualLineage).not.toHaveBeenCalled()
  })

  it('bindingの無い接続を保存場所に使わせない', async () => {
    const { app, registry, pool } = appWith()
    pool.query.mockResolvedValueOnce({ rows: [] })
    const res = await app.request('/lineage/curation/locations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        versionId: '00000000-0000-4000-8000-000000000011',
        location: { connectionId: 'unbound', bucket: 'dataset', key: 'raw/', isPrimary: false, status: 'available' },
        evidenceRefs: [],
      }),
    })
    expect(res.status).toBe(422)
    expect(registry.registerManualLocation).not.toHaveBeenCalled()
  })
})
