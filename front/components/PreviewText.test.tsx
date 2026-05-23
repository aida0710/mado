import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewText } from './PreviewText'

vi.mock('../lib/api/client', () => ({
  api: { textPreview: vi.fn(async () => '') },
}))
vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

afterEach(() => {
  vi.clearAllMocks()
})

describe('PreviewText - copy', () => {
  it('copies the loaded text content', async () => {
    vi.mocked(api.textPreview).mockResolvedValue('hello\nworld')
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld')
  })

  it('shows no copy button while loading', () => {
    // 未解決の Promise でローディング状態に留める
    vi.mocked(api.textPreview).mockReturnValue(new Promise<string>(() => {}))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
    expect(screen.getByText('loading…')).toBeInTheDocument()
  })
})
