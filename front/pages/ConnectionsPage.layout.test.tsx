import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './ConnectionsPage'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: { ...mod.api, listConnections: vi.fn(), setDefaultConnection: vi.fn() },
  }
})

afterEach(() => vi.clearAllMocks())

// R2 の endpoint は空白なしで 60 文字超になる。
const LONG_ENDPOINT = 'https://07d0626c8c662f767b2d07796dc0d087.r2.cloudflarestorage.com'

const conn = {
  id: 'r2', name: 'cloudflare r2', endpoint: LONG_ENDPOINT, region: 'auto',
  accessKeyIdMasked: '20a1…7a30', forcePathStyle: true, listObjectsVersion: 'v2' as const,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
}

// jsdom はレイアウトを行わないので「実際にはみ出すか」は測れない。ここでは
// はみ出しを防いでいる指定が消えていないことだけを固定する (実レンダリングでの
// 確認はスマホ幅のスクリーンショットで実施済み)。
describe('ConnectionsPage の狭い画面向けレイアウト', () => {
  it('長い endpoint を語中で折り返せるようにしている', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('cloudflare r2')).toBeInTheDocument())
    const row = screen.getByText('cloudflare r2').closest('li') as HTMLElement

    // endpoint は ` · ` 区切りの meta 行に他の項目と混在するので、テキストではなく
    // 「折り返し指定を持つ要素が endpoint を含んでいる」ことで引く。
    // wrap-anywhere が無いと、空白を含まない endpoint は折り返せず画面外へ出る。
    const meta = row.querySelector('.wrap-anywhere')
    expect(meta).not.toBeNull()
    expect(meta?.textContent).toContain(LONG_ENDPOINT)
  })

  it('狭い画面では行を縦積みにし、ボタン群も折り返せるようにしている', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('cloudflare r2')).toBeInTheDocument())

    const row = screen.getByText('cloudflare r2').closest('li') as HTMLElement
    // 既定は縦積み、sm 以上で従来の横並びに戻す。
    expect(row.className).toContain('flex-col')
    expect(row.className).toContain('sm:flex-row')

    // 4 ボタンが 360px に収まらないので折り返しを許可する。
    const buttons = screen.getByText('削除').closest('div') as HTMLElement
    expect(buttons.className).toContain('flex-wrap')
  })
})
