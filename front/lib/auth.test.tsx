import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignatureSettings } from '../components/SignatureSettings'
import { fetchOk } from './api/http'
import { AuthGate } from './auth'
import type { AuthUser } from './auth-context'

const signedInUser: AuthUser = {
  id: 'user-1', username: 'aida', email: null, displayName: '相田',
  signatureName: '相田', roles: ['admin'], permissions: [], mustChangePassword: false, authMethods: ['local'],
}

const LOCAL_LOGIN_CONFIG = { localEnabled: true, oidc: { enabled: false } }
const CACHED_LIST_KEY = 'mado.cache.list.v2:list|c|b|p/||'

type Route = (init?: RequestInit) => Response | Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// URL の path ごとに応答を決める fetch。routes に無い path は 404 にする。
function stubServer(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    const route = routes[path]
    return route ? route(init) : json(404, { error: 'not found' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    callsTo: (path: string) => fetchMock.mock.calls.filter(([input]) => String(input).split('?')[0] === path).length,
  }
}

function renderGate() {
  return render(
    <AuthGate>
      <p>ログイン後の画面</p>
      <SignatureSettings />
    </AuthGate>,
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(CACHED_LIST_KEY, JSON.stringify({ value: { directories: ['secret/'] }, expiresAt: Date.now() + 60_000 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate — API の 401', () => {
  it('ログイン中に API が 401 を返し、session も切れていれば、理由を添えてログイン画面へ切り替える', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/internal/notes/home': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()
    await screen.findByText('ログイン後の画面')

    sessionAlive = false
    await act(async () => { await fetchOk('/api/internal/notes/home').catch(() => {}) })

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(screen.getByText('セッションが切れました。もう一度ログインしてください。')).toBeInTheDocument()
    expect(screen.queryByText('ログイン後の画面')).not.toBeInTheDocument()
  })

  it('401 でログイン画面へ切り替えるとき、前の User のキャッシュを消す', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/internal/notes/home': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()
    await screen.findByText('ログイン後の画面')
    expect(localStorage.getItem(CACHED_LIST_KEY)).not.toBeNull()

    sessionAlive = false
    await act(async () => { await fetchOk('/api/internal/notes/home').catch(() => {}) })

    await screen.findByRole('heading', { name: 'ログイン' })
    expect(localStorage.getItem(CACHED_LIST_KEY)).toBeNull()
  })

  it('API が 401 を返しても session が有効なら、画面とキャッシュをそのまま残す', async () => {
    const server = stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/internal/notes/home': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()
    await screen.findByText('ログイン後の画面')

    await act(async () => { await fetchOk('/api/internal/notes/home').catch(() => {}) })

    await waitFor(() => expect(server.callsTo('/api/auth/me')).toBe(2))
    expect(screen.getByText('ログイン後の画面')).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).not.toBeNull()
  })

  it('画面のあちこちで同時に 401 を受けても、session の確認は 1 回にまとめる', async () => {
    let sessionAlive = true
    const server = stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/internal/notes/home': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()
    await screen.findByText('ログイン後の画面')

    sessionAlive = false
    await act(async () => {
      await Promise.all([1, 2, 3].map(() => fetchOk('/api/internal/notes/home').catch(() => {})))
    })

    await screen.findByRole('heading', { name: 'ログイン' })
    expect(server.callsTo('/api/auth/me')).toBe(2) // 起動時の 1 回 + 401 の確認 1 回
  })

  it('認証が無効（AUTH_MODE=disabled）なら、API が 401 を返しても何もしない', async () => {
    const server = stubServer({
      '/api/internal/notes/home': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()
    await screen.findByText('ログイン後の画面')

    await act(async () => { await fetchOk('/api/internal/notes/home').catch(() => {}) })

    expect(server.callsTo('/api/auth/me')).toBe(0)
    expect(screen.getByText('ログイン後の画面')).toBeInTheDocument()
  })

  it('ログイン画面でパスワードを誤って 401 が返っても、session の確認を繰り返さない', async () => {
    const server = stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(401, { error: 'unauthorized' }),
      '/api/auth/local/login': () => json(401, { error: 'invalid identifier or password' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByRole('heading', { name: 'ログイン' })

    await user.type(screen.getByLabelText('ユーザー名またはメールアドレス'), 'aida')
    await user.type(screen.getByLabelText('パスワード'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('パスワードが違います')
    expect(server.callsTo('/api/auth/me')).toBe(1)
    // 起動時の未ログインは「切れた」のではないので、理由は出さない。
    expect(screen.queryByText('セッションが切れました。もう一度ログインしてください。')).not.toBeInTheDocument()
  })
})

describe('AuthGate — サインアウト', () => {
  it('サインアウトに成功すると、キャッシュを消してログイン画面へ切り替える', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/auth/logout': () => json(200, { ok: true, logoutUrl: null }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByRole('button', { name: 'サインアウト' }))

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).toBeNull()
  })

  it('サインアウトがサーバーの失敗（500）で終わると、ログイン状態とキャッシュを保ち、失敗を伝える', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/auth/logout': () => json(500, { error: 'internal error' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByRole('button', { name: 'サインアウト' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'サインアウトできませんでした（HTTP 500）。ログイン状態のままです。時間をおいてもう一度お試しください。',
    )
    expect(screen.getByText('ログイン後の画面')).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).not.toBeNull()
  })

  it('サーバーに接続できずサインアウトできないときも、ログイン状態を保ち、失敗を伝える', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/auth/logout': () => { throw new TypeError('Failed to fetch') },
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByRole('button', { name: 'サインアウト' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'サインアウトできませんでした（サーバーに接続できません）。ログイン状態のままです。時間をおいてもう一度お試しください。',
    )
    expect(screen.getByText('ログイン後の画面')).toBeInTheDocument()
  })

  it('サインアウトの応答が 401（session がもう無い）なら、ログイン画面へ切り替える', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/auth/logout': () => json(401, { error: 'unauthorized' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByRole('button', { name: 'サインアウト' }))

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).toBeNull()
  })
})
