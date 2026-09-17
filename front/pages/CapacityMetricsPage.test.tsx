import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { AuthContext } from '../lib/auth-context'
import { ConnectionContext } from '../lib/connectionContext'
import type { CapacityScanJob, Connection } from '../lib/api/types'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'
import CapacityMetricsPage from './CapacityMetricsPage'

const connection: Connection = {
  id: 'c1', name: 'test', endpoint: 'https://example.com', region: 'auto',
  accessKeyIdMasked: '***', forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON, scanEnabled: true, listCacheTtlSec: 86400,
  capacityTracking: { enabled: true, intervalSeconds: 86400 },
  pricing: PRICING_FIXTURE, isDefault: false, visibility: { mode: 'public', allowedUsers: [] },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

const point = (totalBytes: number, objectCount: number, collectedAt: string) => ({
  totalBytes, objectCount, collectedAt,
})

afterEach(() => vi.restoreAllMocks())

function mount(permissions: string[] | null = null, scanJobs: CapacityScanJob[] = []) {
  vi.spyOn(api, 'capacityOverview').mockResolvedValue({
    connectionId: 'c1', days: 90, capacityBytes: null,
    tracking: {
      enabled: true, intervalSeconds: 86400, nextRunAt: '2026-09-11T00:00:00Z',
      lastAttemptAt: null, lastStatus: 'waiting', lastError: null, consecutiveFailures: 0,
    },
    scan: { jobs: scanJobs },
    buckets: [
      {
        bucket: 'archive', lastSuccessAt: '2026-09-10T00:00:00Z', lastStatus: 'success', lastError: null,
        points: [point(1000, 10, '2026-09-09T00:00:00Z'), point(1500, 12, '2026-09-10T00:00:00Z')],
      },
      {
        bucket: 'dataset', lastSuccessAt: '2026-09-10T00:00:00Z', lastStatus: 'success', lastError: null,
        points: [point(2500, 20, '2026-09-10T00:00:00Z')],
      },
      {
        bucket: 'unmeasured', lastSuccessAt: null, lastStatus: 'waiting', lastError: null,
        points: [],
      },
    ],
  })
  const content = (
    <MemoryRouter initialEntries={['/?view=capacity']}>
      <ConnectionContext.Provider value={connection}>
        <CapacityMetricsPage connectionId="c1" />
      </ConnectionContext.Provider>
    </MemoryRouter>
  )
  if (permissions === null) return render(content)
  return render(
    <AuthContext.Provider value={{
      enabled: true,
      user: {
        id: 'u1', username: 'user', email: null, displayName: 'User', signatureName: 'User',
        roles: ['viewer'], permissions, mustChangePassword: false,
      },
      logout: vi.fn(), reload: vi.fn(),
    }}>
      {content}
    </AuthContext.Provider>,
  )
}

describe('CapacityMetricsPage', () => {
  it('全bucketを同時表示し、connection全体の合計を出す', async () => {
    mount()
    expect(await screen.findByRole('heading', { name: 'archive' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'dataset' })).toBeInTheDocument()
    expect(screen.getByText('3.91 KiB')).toBeInTheDocument()
    expect(screen.getByText('32')).toBeInTheDocument()
    expect(screen.getByText('2 / 3 バケット')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'バケット' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(['dataset', 'archive', 'unmeasured'])
  })

  it('connection編集権限がある場合だけ全bucket強制計測を表示する', async () => {
    const start = vi.spyOn(api, 'startCapacityScan').mockResolvedValue({
      jobs: [{ bucket: 'archive', jobId: 9 }, { bucket: 'dataset', jobId: 10 }],
    })
    const user = userEvent.setup()
    mount(['storage:read', 'connections:manage'])
    await user.click(await screen.findByRole('button', { name: '今すぐ全バケットを計測' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('c1'))
    expect(screen.getByText('2バケットの計測を開始しました。完了すると順次反映されます。')).toBeInTheDocument()
  })

  it('走査中のbucket・経過時間・object数を表示して再実行を無効にする', async () => {
    mount(['storage:read', 'connections:manage'], [{
      jobId: 9, bucket: 'archive', status: 'running', objectCount: 123_456,
      createdAt: '2026-09-10T00:00:00Z', startedAt: new Date().toISOString(),
    }, {
      jobId: 10, bucket: 'dataset', status: 'queued', objectCount: 0,
      createdAt: '2026-09-10T00:00:00Z', startedAt: null,
    }])

    expect(await screen.findByText('archive を走査中…')).toBeInTheDocument()
    expect(screen.getByText(/現在 1分目 · 123,456 オブジェクト目 · 残り 1 バケット/)).toBeInTheDocument()
    expect(screen.getByText('走査中 · 123,456件')).toBeInTheDocument()
    expect(screen.getByText('計測待ち')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '計測中…' })).toBeDisabled()
  })

  it('閲覧userには設定導線と強制計測を表示しない', async () => {
    mount(['storage:read'])
    await screen.findByRole('heading', { name: 'archive' })
    expect(screen.queryByRole('button', { name: '今すぐ全バケットを計測' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'コネクション設定' })).not.toBeInTheDocument()
  })

  it('メトリクス集計が無効なconnectionでは強制計測を無効にする', async () => {
    const restricted = { ...connection, capacityMetricsEnabled: false }
    vi.spyOn(api, 'capacityOverview').mockResolvedValue({
      connectionId: 'c1', days: 90, capacityBytes: null,
      tracking: {
        enabled: false, intervalSeconds: 86400, nextRunAt: null,
        lastAttemptAt: null, lastStatus: 'paused', lastError: null, consecutiveFailures: 0,
      },
      scan: { jobs: [] },
      buckets: [],
    })
    render(
      <MemoryRouter initialEntries={['/?view=capacity']}>
        <ConnectionContext.Provider value={restricted}>
          <CapacityMetricsPage connectionId="c1" />
        </ConnectionContext.Provider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: '今すぐ全バケットを計測' })).toBeDisabled()
  })
})
