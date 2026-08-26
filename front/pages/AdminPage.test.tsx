import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../lib/auth-context'
import AdminPage from './AdminPage'

afterEach(() => vi.restoreAllMocks())

const auth: AuthContextValue = {
  enabled: true,
  user: {
    id: 'admin', username: 'admin', email: null, displayName: 'Admin', signatureName: 'Admin',
    roles: ['admin'], permissions: ['users:manage', 'service_accounts:manage', 'audit:read'],
    mustChangePassword: false,
  },
  logout: async () => {},
  reload: async () => {},
}

describe('AdminPage', () => {
  it('Users・Service Accounts・Auditを専用ページに分ける', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ users: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/users']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    const nav = screen.getByRole('navigation', { name: 'Access' })
    expect(nav).toHaveTextContent('Users')
    expect(nav).toHaveTextContent('Service Accounts')
    expect(nav).toHaveTextContent('Audit')
    expect(screen.queryByRole('heading', { name: 'ユーザーとAPIアクセスの管理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Access' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'ユーザーを追加' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Local Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pipeline Service Accounts' })).not.toBeInTheDocument()
  })

  it('Service Accountsタブ直下で見出しを重複させない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const { container } = render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/service-accounts']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    expect(await screen.findByRole('heading', { name: 'Service Accountを追加' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pipeline Service Accounts' })).not.toBeInTheDocument()
    expect(container.querySelector('.admin-list')).not.toBeInTheDocument()
  })

  it('Auditタブ直下で監査ログ見出しを重複させない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events: [], nextBeforeId: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/audit']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    expect(await screen.findByRole('button', { name: '更新' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '監査ログ' })).not.toBeInTheDocument()
  })
})
