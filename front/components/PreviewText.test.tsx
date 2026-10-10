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
  it('読み込んだテキストをコピーできる', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello\nworld'))
    render(<PreviewText connectionId="c" bucket="b" k="x.txt" />)
    const button = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(button)
    expect(copyToClipboard).toHaveBeenCalledWith('hello\nworld')
  })

  it('読み込み中はコピーボタンを出さない', () => {
    vi.mocked(api.readHead).mockReturnValue(new Promise<Uint8Array>(() => {}))
    render(<PreviewText connectionId="c" bucket="b" k="x.txt" />)
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
    expect(screen.getByText('読み込み中…')).toBeInTheDocument()
  })
})

describe('PreviewText - スニッフ', () => {
  it('拡張子が unknown でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('#!/bin/sh\necho hi'))
    const { container } = render(<PreviewText connectionId="c" bucket="b" k="run.sh" />)
    await screen.findByRole('button', { name: '内容をコピー' })
    expect(container.querySelector('pre.code-view')?.textContent).toBe('#!/bin/sh\necho hi')
  })

  it('NUL を含むファイルは「プレビュー非対応」', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    render(<PreviewText connectionId="c" bucket="b" k="a.npy" />)
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '内容をコピー' })).toBeNull()
  })

  it('取得に失敗したらエラーを出す', async () => {
    vi.mocked(api.readHead).mockRejectedValue(new Error('Not Found'))
    render(<PreviewText connectionId="c" bucket="b" k="x.txt" />)
    expect(await screen.findByText('Not Found')).toBeInTheDocument()
  })
})

describe('PreviewText - 表示形式', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('形式を推測して色を付け、選択欄の「自動」に推測した形式を出す', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('model:\n  layers: 12\n'))
    const { container } = render(<PreviewText connectionId="c" bucket="b" k="configs/train.yaml" />)
    expect(await screen.findByLabelText('表示形式')).toHaveValue('auto')
    expect(screen.getByRole('option', { name: '自動（YAML）' })).toBeInTheDocument()
    expect(container.querySelector('pre.code-view .hljs-attr')?.textContent).toBe('model:')
  })

  it('選び直した形式で表示し、同じ拡張子の次のファイルにも使う。「自動」に戻すと忘れる', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('2026-10-10 12:00:00 ERROR failed\n'))
    const { container, unmount } = render(<PreviewText connectionId="c" bucket="b" k="logs/a.out" />)
    const select = await screen.findByLabelText('表示形式')
    expect(screen.getByRole('option', { name: '自動（ログ）' })).toBeInTheDocument()
    expect(container.querySelector('.code-log-error')).not.toBeNull()

    await userEvent.selectOptions(select, 'plaintext')
    expect(container.querySelector('.code-log-error')).toBeNull()
    expect(JSON.parse(localStorage.getItem('mado.codeLanguage')!)).toEqual({ out: 'plaintext' })
    unmount()

    render(<PreviewText connectionId="c" bucket="b" k="logs/b.out" />)
    const next = await screen.findByLabelText('表示形式')
    expect(next).toHaveValue('plaintext')
    await userEvent.selectOptions(next, 'auto')
    expect(JSON.parse(localStorage.getItem('mado.codeLanguage')!)).toEqual({})
  })
})
