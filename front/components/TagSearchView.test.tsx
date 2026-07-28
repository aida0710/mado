import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { Tag } from '../lib/api/types'
import { TagSearchView } from './TagSearchView'

afterEach(() => vi.restoreAllMocks())

const tags: Tag[] = [
  { id: 't1', name: '処理前', color: '#00ff00' },
  { id: 't2', name: '完了', color: '#0000ff' },
]

function renderView() {
  return render(
    <MemoryRouter>
      <TagSearchView connId="c1" />
    </MemoryRouter>,
  )
}

describe('TagSearchView', () => {
  it('全タグをチップとして出す', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByRole('button', { name: '処理前' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完了' })).toBeInTheDocument()
  })

  it('選択が無いうちは検索せず、案内を出す', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    const spy = vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByText(/タグを選ぶと/)).toBeInTheDocument()
    await waitFor(() => expect(spy).not.toHaveBeenCalled())
  })

  it('チップを選ぶと接続全体を検索してヒットを出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt', kind: 'prefix', path: 'a/b/' },
      { tagId: 't1', bucket: 'bkt2', kind: 'bucket', path: '' },
    ])
    renderView()

    await user.click(await screen.findByRole('button', { name: '処理前' }))

    expect(await screen.findByText('2 件')).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(within(list).getByText('a/b/')).toBeInTheDocument()
    expect(within(list).getByText('(bucket root)')).toBeInTheDocument()
    // 種別が分かるようにラベルを添える。
    expect(within(list).getByText('ディレクトリ')).toBeInTheDocument()
    expect(within(list).getByText('バケット')).toBeInTheDocument()
  })

  it('クリアで選択を解除する', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    await user.click(await screen.findByRole('button', { name: '処理前' }))
    await user.click(await screen.findByRole('button', { name: 'クリア' }))
    expect(await screen.findByText(/タグを選ぶと/)).toBeInTheDocument()
  })

  it('タグが 1 つも無ければ Settings へ誘導する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([])
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByText(/タグがまだありません/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })
})

// 「どの場所にどのタグが付いているか」の持ち運び。
describe('TagSearchView タグ割り当ての入出力', () => {
  const pickFile = async (json: unknown, mode: '追記' | '置き換え' = '追記') => {
    const input = screen.getByLabelText('タグ割り当てをインポート') as HTMLInputElement
    const file = new File([JSON.stringify(json)], 'x.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    // ファイルを選ぶと取り込み方法を聞かれる。既定は追記。
    fireEvent.click(await screen.findByRole('button', { name: mode }))
  }

  it('mado のファイルでなければ取り込まない', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()
    await screen.findByLabelText('タグ割り当てをインポート')

    await pickFile({ hello: 'world' })
    expect(await screen.findByRole('alert')).toHaveTextContent('エクスポートファイルではありません')
  })

  it('既知のタグの割り当てを assignTag で入れ、既存はスキップする', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    // 1 回目 = インポート前の既存確認。't1' が既に bkt/a/ に付いている。
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt', kind: 'prefix', path: 'a/' },
    ])
    const assign = vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    renderView()
    await screen.findByLabelText('タグ割り当てをインポート')

    await pickFile({
      mado: 'tag-assignments', version: 1,
      tags: [{ name: '処理前', color: '#00ff00' }],
      assignments: [
        { tag: '処理前', target: 's3://bkt/a/' },        // 既存 → スキップ
        { tag: '処理前', target: 's3://bkt/b/c.txt' },   // 新規 (file)
        { tag: '処理前', target: 's3://bkt2/' },         // 新規 (bucket)
      ],
    })

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2))
    // パスから種別が決まる: 末尾スラッシュなし=file、空=bucket。
    expect(assign).toHaveBeenCalledWith('c1', 'bkt', 'file', 'b/c.txt', 't1')
    expect(assign).toHaveBeenCalledWith('c1', 'bkt2', 'bucket', '', 't1')
    expect(await screen.findByText('追加 2 件 / スキップ 1 件')).toBeInTheDocument()
  })

  // 取り込み先に無いタグは黙って作らず、作ってよいか聞く。
  it('未登録のタグは確認してから作成する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    const create = vi.spyOn(api, 'createTag').mockResolvedValue({ id: 't9', name: '新タグ', color: '#123456' })
    const assign = vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    renderView()
    await screen.findByLabelText('タグ割り当てをインポート')

    await pickFile({
      mado: 'tag-assignments', version: 1,
      tags: [{ name: '新タグ', color: '#123456' }],
      assignments: [{ tag: '新タグ', target: 's3://bkt/x.txt' }],
    })

    expect(await screen.findByText('未登録のタグがあります')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '作成して取り込む' }))
    // 同梱された色でそのまま作り直す。
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: '新タグ', color: '#123456' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('c1', 'bkt', 'file', 'x.txt', 't9'))
  })

  it('作成しないを選ぶとそのタグの割り当ては入らない', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    const create = vi.spyOn(api, 'createTag')
    const assign = vi.spyOn(api, 'assignTag')
    renderView()
    await screen.findByLabelText('タグ割り当てをインポート')

    await pickFile({
      mado: 'tag-assignments', version: 1,
      tags: [{ name: '新タグ', color: '#123456' }],
      assignments: [{ tag: '新タグ', target: 's3://bkt/x.txt' }],
    })

    fireEvent.click(await screen.findByRole('button', { name: '作成しない' }))
    await waitFor(() => expect(screen.getByText(/失敗 1 件/)).toBeInTheDocument())
    expect(create).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })
})
