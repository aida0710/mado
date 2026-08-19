import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StorageLanding from './StorageLanding'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return { api: { ...mod.api, listConnections: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const conn = (id: string, createdAt: string, isDefault = false) => ({
  id, name: id, endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: true, listObjectsVersion: 'v2' as const,
  capabilities: ALL_CAPABILITIES_ON,
  createdAt, updatedAt: createdAt, isDefault,
  scanEnabled: true, listCacheTtlSec: 86400,
})

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/storage']}>
      <Routes>
        <Route path="/storage" element={<StorageLanding />} />
        <Route path="/storage/:connId/*" element={<output data-testid="dest" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StorageLanding', () => {
  it('デフォルト接続へ直行する (複数あっても選択画面を出さない)', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([
      conn('older', '2026-01-01T00:00:00Z'),
      conn('newer-default', '2026-06-01T00:00:00Z', true),
    ])
    renderLanding()
    await waitFor(() => expect(screen.getByTestId('dest')).toBeInTheDocument())
    expect(screen.queryByText('接続を選択')).not.toBeInTheDocument()
  })

  it('デフォルト未設定なら created_at 最古へ', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([
      conn('newer', '2026-06-01T00:00:00Z'),
      conn('oldest', '2026-01-01T00:00:00Z'),
    ])
    renderLanding()
    await waitFor(() => expect(screen.getByTestId('dest')).toBeInTheDocument())
  })

  it('0 件なら空状態', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([])
    renderLanding()
    await waitFor(() => expect(screen.getByText('接続がまだありません')).toBeInTheDocument())
  })
})
