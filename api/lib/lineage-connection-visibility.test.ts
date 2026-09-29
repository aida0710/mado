import { describe, expect, it } from 'vitest'
import type { DatasetDetail, StorageLocationDetail } from '../shared/lineage-types.js'
import { datasetWithoutHiddenConnections, withoutHiddenConnection } from './lineage-connection-visibility.js'

function location(overrides: Partial<StorageLocationDetail> = {}): StorageLocationDetail {
  return {
    id: 'l1', uri: 's3://raw/a', storageKind: 's3', storageSystemKey: 'mdx-s3', region: null, bucket: 'raw',
    status: 'available', isPrimary: true, observedAt: '2026-09-29T00:00:00Z',
    madoConnectionId: 'hidden0001', metadata: { madoConnectionId: 'hidden0001', note: 'keep' },
    ...overrides,
  }
}

describe('withoutHiddenConnection', () => {
  it('見えない接続の ID は、madoConnectionId からも metadata からも除く', () => {
    const result = withoutHiddenConnection(location(), new Set(['public0001']))
    expect(result.madoConnectionId).toBeNull()
    expect(result.metadata).toEqual({ note: 'keep' })
  })

  it('見える接続と、全接続が見える管理者には、そのまま返す', () => {
    expect(withoutHiddenConnection(location(), new Set(['hidden0001']))).toEqual(location())
    expect(withoutHiddenConnection(location(), null)).toEqual(location())
  })
})

describe('datasetWithoutHiddenConnections', () => {
  it('Dataset のすべての版の保存場所から、見えない接続の ID を除く', () => {
    const detail = {
      datasetId: 'd1', versions: [
        { id: 'v1', locations: [location()] },
        { id: 'v2', locations: [location({ id: 'l2', madoConnectionId: 'public0001', metadata: {} })] },
      ],
    } as unknown as DatasetDetail
    const result = datasetWithoutHiddenConnections(detail, new Set(['public0001']))
    expect(result.versions[0].locations[0]).toMatchObject({ madoConnectionId: null, metadata: { note: 'keep' } })
    expect(result.versions[1].locations[0].madoConnectionId).toBe('public0001')
  })
})
