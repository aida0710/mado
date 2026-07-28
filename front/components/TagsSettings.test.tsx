import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { TagsSettings } from './TagsSettings'

afterEach(() => vi.restoreAllMocks())

describe('TagsSettings', () => {
  it('登録済みタグの一覧を表示する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    render(<TagsSettings />)
    expect(await screen.findByText('重要')).toBeInTheDocument()
  })

  it('「+ 追加」でフォームを開き、保存すると createTag を呼ぶ', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([])
    const createSpy = vi.spyOn(api, 'createTag').mockResolvedValue({ id: 't1', name: '新規', color: '#123456' })
    render(<TagsSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /追加/ })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /追加/ }))
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '新規' } })
    fireEvent.change(screen.getByLabelText('色'), { target: { value: '#123456' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ name: '新規', color: '#123456' }))
  })

  it('削除ボタン → 確認モーダルで確定すると deleteTag を呼ぶ', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    const deleteSpy = vi.spyOn(api, 'deleteTag').mockResolvedValue(undefined)
    render(<TagsSettings />)
    await screen.findByText('重要')

    fireEvent.click(screen.getByRole('button', { name: '重要 を削除' }))
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('t1'))
  })
})

// 環境をまたいでタグ定義を持ち運ぶための入出力。
describe('TagsSettings インポート / エクスポート', () => {
  const pickFile = async (json: unknown, mode: '追記' | '置き換え' = '追記') => {
    const input = screen.getByLabelText('タグをインポート') as HTMLInputElement
    const file = new File([JSON.stringify(json)], 'x.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    // ファイルを選ぶと取り込み方法を聞かれる。既定は追記。
    fireEvent.click(await screen.findByRole('button', { name: mode }))
  }

  it('mado のファイルでなければ取り込まない', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([])
    const create = vi.spyOn(api, 'createTag')
    render(<TagsSettings />)
    await screen.findByLabelText('タグをインポート')

    await pickFile({ hello: 'world' })
    expect(await screen.findByRole('alert')).toHaveTextContent('エクスポートファイルではありません')
    expect(create).not.toHaveBeenCalled()
  })

  // 名前が UNIQUE。同名を上書きすると既存の割り当ての見た目が黙って変わるので
  // スキップする。
  it('同名タグはスキップし、新規だけ作る', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    const create = vi.spyOn(api, 'createTag').mockResolvedValue({ id: 't2', name: '処理前', color: '#00ff00' })
    render(<TagsSettings />)
    await screen.findByText('重要')

    await pickFile({
      mado: 'tags', version: 1,
      tags: [
        { name: '重要', color: '#0000ff' },   // 既存 → スキップ (色が違っても上書きしない)
        { name: '処理前', color: '#00ff00' }, // 新規
      ],
    })

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith({ name: '処理前', color: '#00ff00' })
    expect(await screen.findByText('追加 1 件 / スキップ 1 件')).toBeInTheDocument()
  })
})
