import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { LineageDetailPanel } from './LineageDetailPanel'

const version = {
  id: '11111111-1111-4111-8111-111111111111',
  datasetId: '22222222-2222-4222-8222-222222222222',
  version: 'v1',
  contentHash: 'sha256:content',
  manifestUri: 's3://metadata/callhome.manifest.jsonl',
  manifestHash: 'sha256:manifest',
  schemaUri: null,
  createdAt: '2026-08-26T00:00:00Z',
  metadata: {
    recordKind: 'inventory-observation',
    documentedProcessDate: '2026-01-09頃（厳密な時刻は不明）',
    evidence: { source: 'README.md', verified: true },
  },
  locations: [{
    id: '33333333-3333-4333-8333-333333333333',
    uri: 's3://dataset/callhome/raw/',
    storageKind: 's3',
    storageSystemKey: 'mdx-s3',
    region: null,
    bucket: 'dataset',
    status: 'available' as const,
    isPrimary: true,
    observedAt: '2026-08-26T00:00:00Z',
    madoConnectionId: 'connection 1',
    metadata: {},
  }],
}

describe('LineageDetailPanel', () => {
  it('manifest の由来を出し、binding 済みの保存場所は Storage へリンクする', () => {
    render(
      <MemoryRouter>
        <LineageDetailPanel
          node={{ id: version.id, kind: 'version', label: 'CALLHOME v1', summary: {}, data: {} }}
          detail={version}
          loading={false}
          error={null}
          onClose={vi.fn()}
          onOpenVersion={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('s3://metadata/callhome.manifest.jsonl')).toBeInTheDocument()
    expect(screen.getByText('sha256:manifest')).toBeInTheDocument()
    expect(screen.getByLabelText('補足情報 JSON').textContent).toBe(JSON.stringify(version.metadata, null, 2))
    expect(screen.getByText('2026-01-09頃（厳密な時刻は不明）')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'この保存場所をStorageで開く' }))
      .toHaveAttribute('href', '/storage/connection%201/dataset/callhome/raw/')
  })

  it('binding の無い複製には Storage リンクを出さない', () => {
    render(
      <MemoryRouter>
        <LineageDetailPanel
          node={{ id: version.id, kind: 'version', label: 'CALLHOME v1', summary: {}, data: {} }}
          detail={{ ...version, locations: [{ ...version.locations[0], madoConnectionId: null }] }}
          loading={false}
          error={null}
          onClose={vi.fn()}
          onOpenVersion={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: /Storageで開く/ })).toBeNull()
  })

  it('README の根拠・実行設定・取得元を出す', () => {
    const run = {
      id: '44444444-4444-4444-8444-444444444444',
      runKey: 'backfill-fisher',
      jobNamespace: 'mdx-catalog-backfill',
      jobName: 'SPHからPCM WAVへの変換',
      status: 'COMPLETE' as const,
      startedAt: '2026-08-27T00:00:00Z',
      endedAt: '2026-08-27T00:00:01Z',
      createdAt: '2026-08-31T13:27:25Z',
      gitSha: null,
      containerDigest: null,
      configUri: null,
      configHash: null,
      modelRefs: [],
      runtime: {
        recordKind: 'historical-lineage-assertion', executionTimeStatus: 'unknown',
        documentedProcessDate: '2025-12-27〜2025-12-31頃',
      },
      metrics: { conversations: 11699 },
      errorMessage: null,
      inputs: [],
      outputs: [],
      sources: [{ name: 'Fisher English', uri: 'vendor://ldc/fisher-english' }],
    }
    render(
      <MemoryRouter>
        <LineageDetailPanel
          node={{ id: run.id, kind: 'run', label: run.jobName, summary: {}, data: {} }}
          detail={run}
          loading={false}
          error={null}
          onClose={vi.fn()}
          onOpenVersion={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('実行環境 JSON').textContent).toBe(JSON.stringify(run.runtime, null, 2))
    expect(screen.getByLabelText('実行結果 JSON').textContent).toBe(JSON.stringify(run.metrics, null, 2))
    expect(screen.getByLabelText('入手元 JSON').textContent).toBe(JSON.stringify(run.sources, null, 2))
    expect(screen.queryByLabelText('使用モデル JSON')).toBeNull()
    expect(screen.getByText('2025-12-27〜2025-12-31頃')).toBeInTheDocument()
    expect(screen.queryByText('2026/8/27 9:00:00')).toBeNull()
  })

  it('権限がある場合にDatasetの説明情報を編集できる', async () => {
    const onUpdateDataset = vi.fn().mockResolvedValue({})
    const dataset = {
      kind: 'dataset' as const, datasetId: '22222222-2222-4222-8222-222222222222',
      datasetKey: 'podcast/raw', namespace: 'podcast', name: 'raw', displayName: 'Podcast raw',
      aliases: ['raw'], description: 'before', mediaType: 'audio', owner: null,
      currentVersionId: version.id, versionCount: 1, createdAt: '2026-08-31T00:00:00Z', versions: [version],
    }
    render(
      <MemoryRouter>
        <LineageDetailPanel
          node={{ id: dataset.datasetId, kind: 'dataset', label: dataset.displayName, summary: {}, data: {} }}
          detail={dataset} loading={false} error={null} onClose={vi.fn()} onOpenVersion={vi.fn()}
          canEdit onUpdateDataset={onUpdateDataset}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: '説明情報を編集' }))
    fireEvent.change(screen.getByLabelText('説明'), { target: { value: 'after' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onUpdateDataset).toHaveBeenCalledWith(dataset.datasetId, expect.objectContaining({
      description: 'after', displayName: 'Podcast raw', aliases: ['raw'],
    })))
  })

  it('版のグラフでは埋め込まれた取得元の由来を出す', () => {
    render(
      <MemoryRouter>
        <LineageDetailPanel
          node={{
            id: 'source-1', kind: 'source', label: 'Fisher English', summary: {},
            data: {
              sourceKind: 'purchased', uri: 'vendor://ldc/fisher-english',
              vendor: 'Linguistic Data Consortium', licenseRef: 'license://pending',
            },
          }}
          detail={null}
          loading={false}
          error={null}
          onClose={vi.fn()}
          onOpenVersion={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('購入')).toBeInTheDocument()
    expect(screen.getByText('Linguistic Data Consortium')).toBeInTheDocument()
    expect(screen.getByText('license://pending')).toBeInTheDocument()
  })
})
