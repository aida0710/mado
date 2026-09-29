import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllCaches } from '../lib/api/cache'
import ReadmeEditPage from './ReadmeEditPage'

// Monaco は jsdom で動かないので、本文を見られる textarea に差し替える。
vi.mock('../components/MonacoMarkdownEditor', () => ({
  MonacoMarkdownEditor: ({ value, onChange, ariaLabel }: {
    value: string; onChange: (value: string) => void; ariaLabel: string
  }) => <textarea aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />,
}))

const README_PATH = '/api/internal/storage/c/readme'
const README_CACHE_KEY = 'mado.cache.readme:readme|c|b|docs/'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function readmeBody(body: string) {
  return { exists: true, body, last_editor: 'aida', last_edited_at: '2026-09-29T01:00:00Z', size_bytes: body.length }
}

// README の GET だけ readmeResponses を順に返す。ほか（接続一覧・左ペインの一覧）は 404 にする。
function stubServer(readmeResponses: Array<() => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path !== README_PATH) return json(404, { error: 'not found' })
    const next = readmeResponses.shift()
    return next ? next() : json(500, { error: 'no more responses' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// EditorShell の useBlocker は data router を要求する。
function renderReadmeEditPage() {
  const router = createMemoryRouter(
    [{ path: '/storage/c/edit-readme/:bucket/*', element: <ReadmeEditPage connectionId="c" /> }],
    { initialEntries: ['/storage/c/edit-readme/b/docs/'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  localStorage.clear()
  clearAllCaches()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ReadmeEditPage — 編集の元にする本文', () => {
  it('ブラウザに 6 時間以内のキャッシュがあっても、サーバーの最新の本文から編集を始める', async () => {
    localStorage.setItem(README_CACHE_KEY, JSON.stringify({
      value: readmeBody('古い本文'),
      expiresAt: Date.now() + 60 * 60 * 1000,
    }))
    stubServer([() => json(200, readmeBody('ほかの人が更新した本文'))])
    renderReadmeEditPage()

    expect(await screen.findByLabelText('README 本文 (Markdown)')).toHaveValue('ほかの人が更新した本文')
  })

  it('README を読み込めないと、空のエディタを開かず、理由と再試行を出す', async () => {
    stubServer([() => json(502, { error: 'upstream timeout' })])
    renderReadmeEditPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('READMEを読み込めませんでした（upstream timeout）')
    expect(screen.getByText('既存の本文を上書きしないよう、読み込めるまで編集できません。')).toBeInTheDocument()
    expect(screen.queryByLabelText('README 本文 (Markdown)')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('再試行して読み込めれば、既存の本文でエディタを開く', async () => {
    stubServer([
      () => json(502, { error: 'upstream timeout' }),
      () => json(200, readmeBody('既存の本文')),
    ])
    const user = userEvent.setup()
    renderReadmeEditPage()

    await user.click(await screen.findByRole('button', { name: '再試行' }))

    expect(await screen.findByLabelText('README 本文 (Markdown)')).toHaveValue('既存の本文')
  })
})
