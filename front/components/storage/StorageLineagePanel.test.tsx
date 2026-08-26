import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api/client'
import { StorageLineagePanel } from './StorageLineagePanel'

vi.mock('../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../lib/api/client')>()
  return { api: { ...mod.api, lineageResolveLocation: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

describe('StorageLineagePanel', () => {
  it('登録済みprefixからVersionと論理Lineageへの導線を表示する', async () => {
    vi.mocked(api.lineageResolveLocation).mockResolvedValue({
      storageSystemKey: 'mdx-s3',
      uri: 's3://dataset/podcast/a.tar',
      matches: [{
        kind: 'dataset', datasetId: 'd1', datasetKey: 'podcast', namespace: 'mdx-speech',
        name: 'podcast/raw', displayName: 'Podcast 原本', aliases: [],
        description: null, mediaType: 'audio', owner: null, currentVersionId: 'v1', versionCount: 1,
        versionId: 'v1', version: '2026-08', versionCreatedAt: '2026-08-26T00:00:00Z',
        locationId: 'l1', locationUri: 's3://dataset/podcast/', status: 'available',
        isPrimary: true, observedAt: '2026-08-26T00:00:00Z', matchType: 'prefix',
      }],
    })

    render(
      <MemoryRouter>
        <StorageLineagePanel connId="conn1" bucket="dataset" path="podcast/a.tar" />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Podcast 原本')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '版のLineage' }))
      .toHaveAttribute('href', '/lineage?mode=versions&versionId=v1')
    expect(screen.getByRole('link', { name: '全体を見る' }).getAttribute('href'))
      .toContain('namespace=mdx-speech')
    expect(api.lineageResolveLocation).toHaveBeenCalledWith('conn1', 'dataset', 'podcast/a.tar')
  })

  it('未登録pathでは余計な表示を出さない', async () => {
    vi.mocked(api.lineageResolveLocation).mockResolvedValue({
      storageSystemKey: 'mdx-s3', uri: 's3://dataset/unknown/', matches: [],
    })
    render(
      <MemoryRouter>
        <StorageLineagePanel connId="conn1" bucket="dataset" path="unknown/" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(api.lineageResolveLocation).toHaveBeenCalled())
    expect(screen.queryByLabelText('この保存場所のDataset')).not.toBeInTheDocument()
  })
})
