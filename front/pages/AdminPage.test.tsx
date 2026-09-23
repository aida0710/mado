import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    expect(screen.getByRole('option', { name: 'Viewer — 閲覧のみ' })).toBeInTheDocument()
    expect(screen.getByText('StorageとDataLineageを閲覧できます。')).toBeInTheDocument()
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

  it('Prometheus用のkeyはmetrics:readだけを付け、Namespaceを求めずに発行する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const issuing = init?.method === 'POST'
      const body = issuing
        ? { key: { name: 'grafana', token: 'mado_lin_example.secret' } }
        : { accounts: [{ id: 'sa-1', name: 'prometheus', description: '', status: 'active' }] }
      return new Response(JSON.stringify(body), {
        status: issuing ? 201 : 200, headers: { 'Content-Type': 'application/json' },
      })
    })
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/service-accounts']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    await screen.findByRole('option', { name: 'prometheus' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Service Account/ }), 'sa-1')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^用途/ }), 'metrics:read')
    expect(screen.queryByRole('textbox', { name: '許可するNamespace' })).not.toBeInTheDocument()
    expect(screen.getByText(/利用者を限定した接続も含めて全接続のバケット名・容量を読み取れます/)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Key名' }), 'grafana')
    await userEvent.click(screen.getByRole('button', { name: '一度だけkeyを表示' }))

    expect(await screen.findByText('mado_lin_example.secret')).toBeInTheDocument()
    const issueRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(issueRequest[0]).toBe('/api/internal/service-accounts/sa-1/keys')
    expect(JSON.parse(String(issueRequest[1]!.body)))
      .toEqual({ name: 'grafana', scopes: ['metrics:read'], namespaces: [] })
  })

  it('ユーザー行を展開して編集・再発行・削除を管理できる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      users: [{
        id: 'user-1', username: 'aida', email: 'aida@example.jp', displayName: '相田',
        status: 'active', roles: ['curator'], authMethods: ['local'],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/users']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    const summaryName = await screen.findByText('相田')
    await userEvent.click(summaryName)
    const details = summaryName.closest('details')!
    expect(within(details).getByLabelText('表示名')).toHaveValue('相田')
    expect(within(details).getByLabelText('ユーザーID（ログインID）')).toHaveValue('aida')
    expect(screen.getByText('aida@example.jp')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'パスワードを再発行' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()
  })

  it('SSOユーザーの権限を読み取り専用にしてAuthentikの対応表を表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      users: [{
        id: 'sso-user-1', username: 'sso-user', email: 'sso@example.jp', displayName: 'SSO User',
        status: 'active', roles: ['admin'], authMethods: ['sso'],
      }],
      ssoRoleMapping: {
        'mado-users': 'viewer', 'mado-curators': 'curator',
        'mado-operators': 'operator', 'mado-admins': 'admin',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/access/users']}>
          <Routes><Route path="/settings/access/*" element={<AdminPage />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    const summaryName = await screen.findByText('SSO User')
    await userEvent.click(summaryName)
    const details = summaryName.closest('details')!
    expect(within(details).getByLabelText(/^権限/)).toBeDisabled()
    expect(within(details).getByText('SSO側で管理されるため、Madoからは変更できません。')).toBeInTheDocument()

    const guidance = screen.getByText(/以下のAuthentikグループ/).closest('blockquote')!
    expect(guidance).toHaveTextContent('mado-users→Viewer — 閲覧のみ')
    expect(guidance).toHaveTextContent('mado-curators→Curator — 内容編集')
    expect(guidance).toHaveTextContent('mado-operators→Operator — ジョブ実行')
    expect(guidance).toHaveTextContent('mado-admins→Admin — すべて管理')

    await userEvent.click(within(details).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/internal/users/sso-user-1', expect.objectContaining({ method: 'PATCH' }),
    ))
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/internal/users/sso-user-1/roles', expect.anything(),
    )
  })

  it('Auditタブ直下で監査ログ見出しを重複させない', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      events: [{
        id: 1, occurred_at: '2026-08-26T00:00:00Z', actor_type: 'user', actor_label: 'Admin',
        action: 'user.update', resource_type: 'user', resource_id: 'user-1', outcome: 'success',
        details: { target: { displayName: 'Masaki' }, changes: [{ field: 'username', label: 'ユーザーID', before: 'aida', after: 'masaki' }] },
      }],
      nextBeforeId: null,
    }), {
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
    expect(screen.getByText('時刻')).toBeInTheDocument()
    expect(screen.getByText('ユーザーを変更')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
    await userEvent.click(screen.getByText('ユーザーを変更'))
    expect(screen.getByText('aida')).toBeInTheDocument()
    expect(screen.getByText('masaki')).toBeInTheDocument()
  })
})
