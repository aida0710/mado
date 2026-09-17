import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './ConnectionsPage'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      listConnections: vi.fn(),
      setDefaultConnection: vi.fn(),
    },
  }
})

afterEach(() => vi.clearAllMocks())

const connection = (id: string, isDefault: boolean) => ({
  id, name: id, endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: false, listObjectsVersion: 'v2' as const,
  capabilities: ALL_CAPABILITIES_ON,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault,
  visibility: { mode: 'public' as const, allowedUsers: [] },
  scanEnabled: true, listCacheTtlSec: 86400,
  pricing: PRICING_FIXTURE,
})

describe('ConnectionsPage デフォルト切り替え', () => {
  it('デフォルト行にバッジ、他の行にボタンが出る', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([connection('a', true), connection('b', false)])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('DEFAULT')).toBeInTheDocument())
    expect(screen.getAllByText('デフォルトにする')).toHaveLength(1)
  })

  it('ボタンで setDefaultConnection が呼ばれ一覧を再取得する', async () => {
    vi.mocked(api.listConnections)
      .mockResolvedValueOnce([connection('a', true), connection('b', false)])
      .mockResolvedValueOnce([connection('a', false), connection('b', true)])
    vi.mocked(api.setDefaultConnection).mockResolvedValue(undefined)
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('デフォルトにする')).toBeInTheDocument())
    fireEvent.click(screen.getByText('デフォルトにする'))
    await waitFor(() => expect(api.setDefaultConnection).toHaveBeenCalledWith('b'))
    expect(api.listConnections).toHaveBeenCalledTimes(2)
  })
})
