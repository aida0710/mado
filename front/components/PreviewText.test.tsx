import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewText } from './PreviewText'

vi.mock('../lib/api/client', () => ({
  api: {
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    readHead: vi.fn(async () => new Uint8Array(0)),
  },
}))
vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

afterEach(() => {
  vi.clearAllMocks()
})

describe('PreviewText - copy', () => {
  it('copies the loaded text content', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello\nworld'))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld')
  })

  it('shows no copy button while loading', () => {
    vi.mocked(api.readHead).mockReturnValue(new Promise<Uint8Array>(() => {}))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
    expect(screen.getByText('loading…')).toBeInTheDocument()
  })
})

describe('PreviewText - スニッフ', () => {
  it('拡張子が unknown でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('#!/bin/sh\necho hi'))
    render(<PreviewText connId="c" bucket="b" k="run.sh" />)
    expect(await screen.findByText(/echo hi/)).toBeInTheDocument()
  })

  it('NUL を含むファイルは「プレビュー非対応」', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    render(<PreviewText connId="c" bucket="b" k="a.npy" />)
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
  })

  it('取得に失敗したらエラーを出す', async () => {
    vi.mocked(api.readHead).mockRejectedValue(new Error('Not Found'))
    render(<PreviewText connId="c" bucket="b" k="x.txt" />)
    expect(await screen.findByText('Not Found')).toBeInTheDocument()
  })
})
