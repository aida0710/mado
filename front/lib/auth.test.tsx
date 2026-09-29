import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignatureSettings } from '../components/SignatureSettings'
import NoteEditPage from '../pages/NoteEditPage'
import { fetchOk } from './api/http'
import { AuthGate } from './auth'
import type { AuthUser } from './auth-context'

// Monaco は jsdom で動かないので、本文を見られる textarea に差し替える。
vi.mock('../components/MonacoMarkdownEditor', () => ({
  MonacoMarkdownEditor: ({ value, onChange, ariaLabel }: {
    value: string; onChange: (value: string) => void; ariaLabel: string
  }) => <textarea aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />,
}))

const signedInUser: AuthUser = {
  id: 'user-1', username: 'aida', email: null, displayName: '相田',
  signatureName: '相田', roles: ['admin'], permissions: [], mustChangePassword: false, authMethods: ['local'],
}

const otherUser: AuthUser = {
  ...signedInUser, id: 'user-2', username: 'sato', displayName: '佐藤', signatureName: '佐藤',
}

const LOCAL_LOGIN_CONFIG = { localEnabled: true, oidc: { enabled: false } }
const SSO_ONLY_CONFIG = { localEnabled: false, oidc: { enabled: true, label: 'Authentik' } }
const HOME_NOTE = { exists: true, body: '保存済みの本文', last_editor: '相田', last_edited_at: '2026-09-29T01:00:00Z' }
const NOTE_BODY_LABEL = 'ノート本文 (Markdown)'
const DRAFT = '書きかけの下書き'
const CACHED_LIST_KEY = 'mado.cache.list.v2:list|c|b|p/||'

// 401 → /api/auth/me の取り直し → ログイン画面の描画、と非同期が 3 段続くので、
// 並列実行で CPU が混んでいても待てる時間を取る (ほかのテストと同じ 3 秒)。
const SESSION_CHECK_TIMEOUT_MS = 3000

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

// Team note の編集画面を AuthGate の中に描く。EditorShell の useBlocker が data router を
// 要るので、main.tsx と同じく router の中に AuthGate を置く。
function renderNoteEditorInGate() {
  const router = createMemoryRouter(
    [{ path: '*', element: <AuthGate><NoteEditPage /></AuthGate> }],
    { initialEntries: ['/edit-note'] },
  )
  return render(<RouterProvider router={router} />)
}

// Team note の API。保存（PUT）は session があるときだけ受け付け、受け取った本文を savedBodies に残す。
function noteRoute(hasSession: () => boolean, savedBodies: string[] = []): Route {
  return init => {
    if (init?.method !== 'PUT') return json(200, HOME_NOTE)
    if (!hasSession()) return json(401, { error: 'unauthorized' })
    savedBodies.push((JSON.parse(String(init.body)) as { body: string }).body)
    return json(200, { ok: true })
  }
}

// 編集画面で本文を書き換え、session が切れた状態で保存を押す。ログイン画面が重なるまで待つ。
async function saveDraftAfterSessionExpired(user: UserEvent, expireSession: () => void) {
  const editor = await screen.findByLabelText(NOTE_BODY_LABEL)
  await user.clear(editor)
  await user.type(editor, DRAFT)
  expireSession()
  await user.click(screen.getByRole('button', { name: '保存' }))
  return screen.findByRole('dialog', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })
}

async function logInLocally(user: UserEvent) {
  await user.type(screen.getByLabelText('ユーザー名またはメールアドレス'), 'aida')
  await user.type(screen.getByLabelText('パスワード'), 'correct-password')
  await user.click(screen.getByRole('button', { name: 'ログイン' }))
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(CACHED_LIST_KEY, JSON.stringify({ value: { directories: ['secret/'] }, expiresAt: Date.now() + 60_000 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuthGate — API の 401', () => {
  it('ログイン中に API が 401 を返し、session も切れていれば、理由を添えたログイン画面を重ね、前の画面を操作できなくする', async () => {
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

    expect(await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
    expect(screen.getByText('セッションが切れました。もう一度ログインしてください。')).toBeInTheDocument()
    expect(screen.getByText('ログイン後の画面').closest('[inert]')).not.toBeNull()
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

    await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })
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

    await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })
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
    await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })

    await user.type(screen.getByLabelText('ユーザー名またはメールアドレス'), 'aida')
    await user.type(screen.getByLabelText('パスワード'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('パスワードが違います')
    expect(server.callsTo('/api/auth/me')).toBe(1)
    // 起動時の未ログインは「切れた」のではないので、理由は出さない。
    expect(screen.queryByText('セッションが切れました。もう一度ログインしてください。')).not.toBeInTheDocument()
  })
})

describe('AuthGate — 編集中に session が切れたとき', () => {
  // 本番では router が window.location を動かす。テストの memory router は動かさないので、
  // ログイン画面が見る URL を編集画面にそろえる。
  beforeEach(() => { window.history.replaceState(null, '', '/edit-note') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('保存が 401 で session も切れていたら、本文を残したままログイン画面を重ね、同じ User で入り直すと続きから保存できる', async () => {
    let sessionAlive = true
    const savedBodies: string[] = []
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/auth/local/login': () => { sessionAlive = true; return json(200, { ok: true }) },
      '/api/internal/notes/home': noteRoute(() => sessionAlive, savedBodies),
    })
    const user = userEvent.setup()
    renderNoteEditorInGate()

    await saveDraftAfterSessionExpired(user, () => { sessionAlive = false })

    expect(screen.getByText('セッションが切れました。もう一度ログインしてください。')).toBeInTheDocument()
    expect(screen.getByLabelText(NOTE_BODY_LABEL)).toHaveValue(DRAFT)

    await logInLocally(user)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText(NOTE_BODY_LABEL)).toHaveValue(DRAFT)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(savedBodies).toEqual([DRAFT]))
  })

  it('ログイン画面を重ねている間は、背後の画面を操作させず、focus とキー操作もログイン画面の中に留める', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/internal/notes/home': noteRoute(() => sessionAlive),
    })
    const user = userEvent.setup()
    renderNoteEditorInGate()

    const dialog = await saveDraftAfterSessionExpired(user, () => { sessionAlive = false })

    expect(screen.getByLabelText(NOTE_BODY_LABEL).closest('[inert]')).not.toBeNull()
    expect(dialog.closest('[inert]')).toBeNull()
    expect(dialog).toHaveFocus()
    // 背後の画面には window で Escape を受けて閉じるモーダルなどがある。
    const keyReachedWindow = vi.fn()
    window.addEventListener('keydown', keyReachedWindow)
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', keyReachedWindow)
    expect(keyReachedWindow).not.toHaveBeenCalled()
  })

  it('session が切れたあと別の User で入り直すと、前の User の書きかけを残さず開き直す', async () => {
    let currentUser: AuthUser | null = signedInUser
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => currentUser ? json(200, { user: currentUser }) : json(401, { error: 'unauthorized' }),
      '/api/auth/local/login': () => { currentUser = otherUser; return json(200, { ok: true }) },
      '/api/internal/notes/home': noteRoute(() => currentUser !== null),
    })
    const user = userEvent.setup()
    renderNoteEditorInGate()

    await saveDraftAfterSessionExpired(user, () => { currentUser = null })
    await logInLocally(user)

    await waitFor(
      () => expect(screen.getByLabelText(NOTE_BODY_LABEL)).toHaveValue(HOME_NOTE.body),
      { timeout: SESSION_CHECK_TIMEOUT_MS },
    )
    expect(screen.queryByDisplayValue(DRAFT)).not.toBeInTheDocument()
    expect(screen.getByLabelText('編集者名')).toHaveValue(otherUser.signatureName)
  })

  it('SSO は新しいタブでログインさせ、このタブへ戻ったときに入り直せていれば、画面をそのまま戻す', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, SSO_ONLY_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/internal/notes/home': noteRoute(() => sessionAlive),
    })
    const user = userEvent.setup()
    renderNoteEditorInGate()

    await saveDraftAfterSessionExpired(user, () => { sessionAlive = false })
    const ssoLink = screen.getByRole('link', { name: 'Authentikで続行' })
    expect(ssoLink).toHaveAttribute('target', '_blank')
    // 新しいタブで同じ編集画面を開かせない（同じ本文を 2 つのエディタで書き換えないように）。
    expect(ssoLink).toHaveAttribute('href', '/api/auth/oidc/start?returnTo=%2F')

    sessionAlive = true // 別のタブで SSO のログインを済ませた
    fireEvent.focus(window)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText(NOTE_BODY_LABEL)).toHaveValue(DRAFT)
  })

  it('起動時にまだログインしていなければ、重ねずにログイン画面だけを出す', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(401, { error: 'unauthorized' }),
    })
    renderGate()

    expect(await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('ログイン後の画面')).not.toBeInTheDocument()
  })
})

describe('AuthGate — 設定画面と初回のパスワード変更での 401', () => {
  it('アカウントの保存で 401 を受け、session も切れていれば、ログイン画面を重ねる', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/auth/profile': () => json(401, { error: 'unauthorized' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    sessionAlive = false
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('dialog', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
  })

  it('パスワードの変更で 401 を受け、session も切れていれば、ログイン画面を重ねる', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive ? json(200, { user: signedInUser }) : json(401, { error: 'unauthorized' }),
      '/api/auth/change-password': () => json(401, { error: 'unauthorized' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByText('パスワードを変更'))
    await user.type(screen.getByLabelText('現在のパスワード'), 'current-password')
    await user.type(screen.getByLabelText('新しいパスワード（12文字以上）'), 'new-password-123')
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), 'new-password-123')
    sessionAlive = false
    await user.click(screen.getByRole('button', { name: '変更' }))

    expect(await screen.findByRole('dialog', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
  })

  it('初回のパスワード変更で 401 を受け、session も切れていれば、理由を添えてログイン画面へ戻す', async () => {
    let sessionAlive = true
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => sessionAlive
        ? json(200, { user: { ...signedInUser, mustChangePassword: true } })
        : json(401, { error: 'unauthorized' }),
      '/api/auth/change-password': () => json(401, { error: 'unauthorized' }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByRole('heading', { name: 'パスワードを変更' }, { timeout: SESSION_CHECK_TIMEOUT_MS })

    await user.type(screen.getByLabelText('現在のパスワード'), 'initial-password')
    await user.type(screen.getByLabelText('新しいパスワード（12文字以上）'), 'new-password-123')
    await user.type(screen.getByLabelText('新しいパスワード（確認）'), 'new-password-123')
    sessionAlive = false
    await user.click(screen.getByRole('button', { name: '変更して続行' }))

    expect(await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
    expect(screen.getByText('セッションが切れました。もう一度ログインしてください。')).toBeInTheDocument()
  })
})

describe('AuthGate — サインアウト', () => {
  it('サインアウトに成功すると、キャッシュと前の画面を消してログイン画面へ切り替える', async () => {
    stubServer({
      '/api/auth/config': () => json(200, LOCAL_LOGIN_CONFIG),
      '/api/auth/me': () => json(200, { user: signedInUser }),
      '/api/auth/logout': () => json(200, { ok: true, logoutUrl: null }),
    })
    const user = userEvent.setup()
    renderGate()
    await screen.findByText('ログイン後の画面')

    await user.click(screen.getByRole('button', { name: 'サインアウト' }))

    expect(await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).toBeNull()
    expect(screen.queryByText('ログイン後の画面')).not.toBeInTheDocument()
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

  // 要求がサーバーに届いて session を失効させたあとで通信が切れた可能性もあるので、
  // 「ログイン状態のまま」とは言い切らない。
  it('サーバーに接続できないときは、サインアウトできたか確認できなかったと伝え、画面を残す', async () => {
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
      'サーバーに接続できず、サインアウトできたか確認できませんでした。もう一度お試しください。',
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

    expect(await screen.findByRole('heading', { name: 'ログイン' }, { timeout: SESSION_CHECK_TIMEOUT_MS })).toBeInTheDocument()
    expect(localStorage.getItem(CACHED_LIST_KEY)).toBeNull()
  })
})
