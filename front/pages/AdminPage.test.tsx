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
    expect(await screen.findByRole('heading', { name: 'Local Users' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pipeline Service Accounts' })).not.toBeInTheDocument()
  })
})
