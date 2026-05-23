import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadmeView } from './ReadmeView'

vi.mock('../lib/api/client', () => ({
  api: {
    readme: vi.fn(),
    invalidateReadme: vi.fn(),
    lastFetched: { readme: vi.fn(() => null) },
  },
}))

import { api } from '../lib/api/client'

const readmeMock = api.readme as ReturnType<typeof vi.fn>

// jsdom はレイアウトを行わず scrollHeight / clientHeight は常に 0 を返す。
// 折りたたみ判定 (scrollHeight > clientHeight) を効かせるため prototype を差し替える。
let origScroll: PropertyDescriptor | undefined
let origClient: PropertyDescriptor | undefined
function mockHeights(scroll: number, client: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scroll })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => client })
}

beforeEach(() => {
  origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
})

afterEach(() => {
  if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScroll)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  if (origClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClient)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  vi.clearAllMocks()
})

function renderView() {
  return render(
    <MemoryRouter>
      <ReadmeView connId="c" bucket="b" prefix="p/" />
    </MemoryRouter>,
  )
}

describe('ReadmeView - collapse fade', () => {
  it('does NOT render the bottom fade when the README fits within the collapsed height', async () => {
    mockHeights(100, 100) // scrollHeight == clientHeight → 収まっている (= 短い README)
    readmeMock.mockResolvedValue({ exists: true, body: '# short' })
    const { container } = renderView()
    await screen.findByRole('heading', { name: 'short' })
    const body = container.querySelector('.markdown-body')!
    // クリップ (max-height) 自体は維持しつつ、もや (is-faded) は出さない。
    await waitFor(() => expect(body.className).not.toContain('is-faded'))
    expect(body.className).toContain('is-collapsed')
  })

  it('renders the bottom fade only when the README overflows the collapsed height', async () => {
    mockHeights(1000, 100) // scrollHeight > clientHeight → あふれている (= 長い README)
    readmeMock.mockResolvedValue({ exists: true, body: '# long' })
    const { container } = renderView()
    await screen.findByRole('heading', { name: 'long' })
    const body = container.querySelector('.markdown-body')!
    await waitFor(() => expect(body.className).toContain('is-faded'))
  })
})
