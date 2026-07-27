import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { Tag } from '../lib/api/types'
import { TagPanel } from './TagPanel'

afterEach(() => vi.restoreAllMocks())

const tags: Tag[] = [
  { id: 't1', name: '処理前', color: '#00ff00' },
  { id: 't2', name: '完了', color: '#0000ff' },
]

function renderPanel(selected: string[] = [], onToggle = vi.fn(), onClear = vi.fn()) {
  const utils = render(
    <MemoryRouter>
      <TagPanel
        connId="c1"
        allTags={tags}
        selected={new Set(selected)}
        onToggle={onToggle}
        onClear={onClear}
      />
    </MemoryRouter>,
  )
  return { ...utils, onToggle, onClear }
}

describe('TagPanel', () => {
  it('既定では畳んでおり、チップを出さない', () => {
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderPanel()
    expect(screen.getByRole('button', { name: /タグ/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '処理前' })).not.toBeInTheDocument()
  })

  it('開くと全タグをチップとして出す (表示中の行に無いタグも選べる)', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderPanel()

    await user.click(screen.getByRole('button', { name: /タグ/ }))
    expect(screen.getByRole('button', { name: '処理前' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完了' })).toBeInTheDocument()
  })

  it('チップを押すと onToggle が呼ばれる', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    const { onToggle } = renderPanel()

    await user.click(screen.getByRole('button', { name: /タグ/ }))
    await user.click(screen.getByRole('button', { name: '処理前' }))
    expect(onToggle).toHaveBeenCalledWith('t1')
  })

  // 閉じたら閉じたまま。ただし絞り込みが効いていること自体は分かるように件数を出す。
  it('畳んでいる間は選択中のタグを出さず、件数だけをラベルに添える', () => {
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderPanel(['t1'])

    const head = screen.getByRole('button', { name: /タグ/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('(1)')
    expect(screen.queryByText('処理前')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'クリア' })).not.toBeInTheDocument()
  })

  it('選択があると接続全体を検索し、ヒット件数を畳んで出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt', kind: 'prefix', path: 'a/b/' },
      { tagId: 't1', bucket: 'bkt2', kind: 'bucket', path: '' },
    ])
    renderPanel(['t1'])

    await user.click(screen.getByRole('button', { name: /タグ/ }))
    const disclosure = await screen.findByRole('button', { name: /接続全体のヒット 2 件/ })
    // 件数だけ見せて中身は畳んでおく。
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')

    await user.click(disclosure)
    const list = screen.getByRole('list')
    expect(within(list).getByText('a/b/')).toBeInTheDocument()
    expect(within(list).getByText('(bucket root)')).toBeInTheDocument()
  })

  it('選択が無いときは検索しない', async () => {
    const spy = vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderPanel([])
    await waitFor(() => expect(spy).not.toHaveBeenCalled())
  })

  it('タグが 1 つも無ければ何も描画しない', () => {
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    const { container } = render(
      <MemoryRouter>
        <TagPanel connId="c1" allTags={[]} selected={new Set()} onToggle={vi.fn()} onClear={vi.fn()} />
      </MemoryRouter>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
