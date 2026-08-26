import { render, screen } from '@testing-library/react'
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
  metadata: {},
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
    madoConnectionId: 'conn 1',
    metadata: {},
  }],
}

describe('LineageDetailPanel', () => {
  it('shows manifest provenance and links a bound location into Storage', () => {
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
    expect(screen.getByRole('link', { name: 'この保存場所をStorageで開く' }))
      .toHaveAttribute('href', '/storage/conn%201/dataset/callhome/raw/')
  })

  it('does not render a Storage link for an unbound replica', () => {
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
})
