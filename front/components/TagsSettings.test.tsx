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
