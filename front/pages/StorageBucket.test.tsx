import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StorageBucket from './StorageBucket'
import { api } from '../lib/api/client'
import { ConnectionContext } from '../lib/connectionContext'
import type { Connection } from '../lib/api/types'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      list: vi.fn(),
      readme: vi.fn(),
      listConnections: vi.fn(),
      lineageLinks: vi.fn(),
    },
  }
})

afterEach(() => vi.clearAllMocks())

const connection: Connection = {
  id: 'c1', name: 'c1', endpoint: 'http://e', region: 'r', accessKeyIdMasked: 'x…y',
  forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
}

function renderPage() {
  vi.mocked(api.list).mockResolvedValue({ directories: [], files: [], nextContinuation: null, nextStartAfter: null })
  vi.mocked(api.readme).mockResolvedValue({ exists: false })
  vi.mocked(api.listConnections).mockResolvedValue([connection])
  vi.mocked(api.lineageLinks).mockResolvedValue([])
  return render(
    <MemoryRouter initialEntries={['/storage/c1/bucket-a/']}>
      <ConnectionContext.Provider value={connection}>
        <Routes>
          <Route path="/storage/:connId/:bucket/*" element={<StorageBucket connId="c1" />} />
        </Routes>
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('StorageBucket のタブ切り替え', () => {
  it('既定では一覧タブが選択され、家系図は取得しない', async () => {
    renderPage()
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'true')
    expect(api.lineageLinks).not.toHaveBeenCalled()
  })

  it('「家系図」タブを押すと LineageView が描画され、一覧タブに戻せる', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(api.list).toHaveBeenCalled())

    await user.click(screen.getByRole('tab', { name: /家系図/ }))
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledWith('c1'))
    expect(screen.getByRole('tab', { name: /家系図/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'false')

    await user.click(screen.getByRole('tab', { name: '一覧' }))
    expect(screen.getByRole('tab', { name: '一覧' })).toHaveAttribute('aria-selected', 'true')
  })
})
