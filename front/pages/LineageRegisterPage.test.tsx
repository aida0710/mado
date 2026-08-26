import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthUser } from '../lib/auth-context'
import { api } from '../lib/api/client'
import LineageRegisterPage from './LineageRegisterPage'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return { api: {
    ...mod.api,
    listConnections: vi.fn().mockResolvedValue([]),
    lineageCatalog: vi.fn().mockResolvedValue({ results: [], totalCount: 0 }),
    lineageDataset: vi.fn(),
    registerManualDataset: vi.fn().mockResolvedValue({ version: { id: '00000000-0000-4000-8000-000000000011' } }),
    registerManualLocation: vi.fn(),
    registerManualLineage: vi.fn(),
  } }
})

afterEach(() => vi.clearAllMocks())

const curator: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001', username: 'curator', email: null,
  displayName: 'Curator', signatureName: 'Curator', roles: ['curator'],
  permissions: ['storage:read', 'lineage:read', 'lineage:curate'], mustChangePassword: false,
}

function renderPage(user: AuthUser = curator) {
  return render(
    <AuthContext.Provider value={{ enabled: true, user, logout: vi.fn(), reload: vi.fn() }}>
      <MemoryRouter><LineageRegisterPage /></MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('LineageRegisterPage', () => {
  it('登録種別ごとに用途を分ける', async () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Dataset' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存場所' }))
    expect(screen.getByText(/同じ内容を別の場所へコピー/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '処理履歴' }))
    expect(screen.getByText(/既存データ同士の処理履歴/)).toBeInTheDocument()
    await waitFor(() => expect(api.listConnections).toHaveBeenCalled())
  })

  it('lineage:curateが無い利用者には登録フォームを出さない', () => {
    renderPage({ ...curator, permissions: ['storage:read', 'lineage:read'] })
    expect(screen.getByText('手動登録の権限がありません。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登録する' })).not.toBeInTheDocument()
  })

  it('新しいDatasetとVersionを保存場所なしで登録する', async () => {
    renderPage()
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: 'Podcast 日本語 原本' } })
    fireEvent.change(screen.getByLabelText('Dataset key'), { target: { value: 'podcast/ja/raw' } })
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'mdx-speech' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'podcast/ja/raw' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2026-08-27' } })
    fireEvent.click(screen.getByLabelText('保存場所も登録する'))
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))

    await waitFor(() => expect(api.registerManualDataset).toHaveBeenCalledWith(expect.objectContaining({
      dataset: expect.objectContaining({
        displayName: 'Podcast 日本語 原本', datasetKey: 'podcast/ja/raw',
        namespace: 'mdx-speech', name: 'podcast/ja/raw',
      }),
      version: expect.objectContaining({ version: '2026-08-27' }),
      evidenceRefs: [],
    })))
    expect(await screen.findByText('Dataset Versionを登録しました。')).toBeInTheDocument()
  })
})
