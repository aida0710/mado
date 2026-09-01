import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../lib/auth-context'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'
import SettingsPage from './SettingsPage'

afterEach(() => vi.restoreAllMocks())

describe('SettingsPage', () => {
  const auth: AuthContextValue = {
    enabled: true,
    user: {
      id: 'admin', username: 'admin', email: null, displayName: 'Admin', signatureName: 'Admin',
      roles: ['admin'], permissions: ['users:manage', 'service_accounts:manage', 'audit:read'],
      mustChangePassword: false,
    },
    logout: async () => {}, reload: async () => {},
  }

  it('設定領域を専用ページのナビゲーションに分ける', () => {
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/account']}>
          <Routes><Route path="/settings/*" element={<SettingsPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(nav).toHaveTextContent('Account')
    expect(nav).toHaveTextContent('Connections')
    expect(nav).toHaveTextContent('Features')
    expect(nav).toHaveTextContent('Access')
    expect(nav).toHaveTextContent('About')
    expect(screen.getByLabelText('署名名')).toBeInTheDocument()
  })

  it('接続追加はモーダルではなく専用ページに表示する', () => {
    render(
      <MemoryRouter initialEntries={['/settings/connections/new']}>
        <Routes><Route path="/settings/*" element={<SettingsPage />} /></Routes>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: '接続を追加' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('基本情報')).toBeInTheDocument()
    expect(screen.getByText('認証情報')).toBeInTheDocument()
  })

  it('接続IDのURLから編集ページを開ける', async () => {
    vi.spyOn(api, 'listConnections').mockResolvedValue([{
      id: 'conn-1', name: 'production', endpoint: 'https://s3.example.com', region: 'auto',
      accessKeyIdMasked: 'AKIA…TEST', forcePathStyle: true, listObjectsVersion: 'v2',
      capabilities: ALL_CAPABILITIES_ON, scanEnabled: true, listCacheTtlSec: 86400,
      pricing: PRICING_FIXTURE, isDefault: true,
      visibility: { mode: 'public', allowedUsers: [] },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }])
    render(
      <MemoryRouter initialEntries={['/settings/connections/conn-1']}>
        <Routes><Route path="/settings/*" element={<SettingsPage />} /></Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '接続を編集' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('production')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
