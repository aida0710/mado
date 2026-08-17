import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { FeatureSettings } from './FeatureSettings'

afterEach(() => vi.restoreAllMocks())

describe('FeatureSettings', () => {
  it('設定が無ければ有効として出す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({})
    render(<FeatureSettings />)
    expect(await screen.findByRole('checkbox', { name: 'タグを表示する' })).toBeChecked()
  })

  it("'false' の設定を反映する", async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ tags_enabled: 'false' })
    render(<FeatureSettings />)
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'タグを表示する' })).not.toBeChecked())
  })

  it('トグルすると該当キーだけを保存する', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({})
    const put = vi.spyOn(api, 'putSetting').mockResolvedValue(undefined)
    render(<FeatureSettings />)

    await userEvent.click(await screen.findByRole('checkbox', { name: 'タグを表示する' }))
    expect(put).toHaveBeenCalledExactlyOnceWith('tags_enabled', 'false')
  })

  it('保存に失敗したらトグルを戻してエラーを出す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({})
    vi.spyOn(api, 'putSetting').mockRejectedValue(new Error('boom'))
    render(<FeatureSettings />)

    const box = await screen.findByRole('checkbox', { name: 'タグを表示する' })
    await userEvent.click(box)
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
    expect(box).toBeChecked()
  })
})
