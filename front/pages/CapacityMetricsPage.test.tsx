import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { ConnectionContext } from '../lib/connectionContext'
import type { Connection } from '../lib/api/types'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'
import CapacityMetricsPage from './CapacityMetricsPage'

const connection: Connection = {
  id: 'c1', name: 'test', endpoint: 'https://example.com', region: 'auto',
  accessKeyIdMasked: '***', forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON, scanEnabled: true, listCacheTtlSec: 86400,
  pricing: PRICING_FIXTURE, isDefault: false, visibility: { mode: 'public', allowedUsers: [] },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

afterEach(() => vi.restoreAllMocks())

function mount() {
  vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'dataset', creationDate: null }] })
  vi.spyOn(api, 'capacityHistory').mockResolvedValue({
    connectionId: 'c1', bucket: 'dataset', days: 90, capacityBytes: null,
    tracking: {
      enabled: false, intervalSeconds: 86400, nextRunAt: null,
      lastAttemptAt: null, lastSuccessAt: null, lastStatus: null, lastError: null,
      consecutiveFailures: 0,
    },
    points: [],
  })
  return render(
    <MemoryRouter initialEntries={['/?view=capacity&bucket=dataset']}>
      <ConnectionContext.Provider value={connection}>
        <CapacityMetricsPage connId="c1" />
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('CapacityMetricsPage', () => {
  it('履歴がない状態と明示的な追跡開始操作を表示する', async () => {
    mount()
    expect(await screen.findByText('履歴はまだありません')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '定期計測を有効化' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '今すぐ計測' })).toBeInTheDocument()
  })

  it('追跡開始時に選択中の間隔を保存する', async () => {
    const user = userEvent.setup()
    const save = vi.spyOn(api, 'setCapacityTracking').mockResolvedValue({
      tracking: {
        enabled: true, intervalSeconds: 86400, nextRunAt: '2026-09-11T00:00:00Z',
        lastAttemptAt: null, lastSuccessAt: null, lastStatus: 'waiting', lastError: null,
        consecutiveFailures: 0,
      },
    })
    mount()
    await user.click(await screen.findByRole('button', { name: '定期計測を有効化' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('c1', 'dataset', true, 86400))
  })
})
