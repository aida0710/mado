import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TarEntryModal } from './TarEntryModal'
import { PinnedPreviewsProvider, usePinnedPreviews } from '../lib/pinnedPreviews'

vi.mock('../lib/api/client', () => ({
  api: {
    // 本物と同じく **相対パス** を返す (絶対 URL を返すとコピー値のバグを見逃す)。
    tarEntryUrl: vi.fn(() => '/api/internal/storage/c/preview/tar-entry?bucket=b&key=a.tar&entry=x'),
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

function renderEntry(name: string) {
  render(
    <TarEntryModal
      connId="c"
      bucket="b"
      archiveKey="a.tar"
      entry={{ name, size: 7, type: '' }}
      onClose={() => {}}
    />,
  )
}

describe('TarEntryModal - copy all', () => {
  it('copies the full pretty-printed text of a .json entry', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1}'))
    renderEntry('x.json')
    // テキスト読み込み後にコピーボタンが現れる
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('copies the raw text of a .jsonl entry (no pretty-print)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1}\n{"b":2}'))
    renderEntry('x.jsonl')
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{"a":1}\n{"b":2}')
  })
})

describe('TarEntryModal - スニッフ', () => {
  it('拡張子が未知でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('root:x:0:0'))
    renderEntry('etc/passwd')
    expect(await screen.findByText(/root:x:0:0/)).toBeInTheDocument()
  })

  it('NUL を含むエントリは「プレビュー非対応」', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    renderEntry('feat.npy')
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
  })
})

describe('TarEntryModal - URL コピー', () => {
  it('🔗 メニューから Web URL / 生データ URL をコピーできる', async () => {
    // 本文プレビューは関係ないので、fetch を伴わない unknown 種別 (.bin) で開く。
    render(
      <TarEntryModal
        connId="c" bucket="b" archiveKey="rec/a.tar"
        entry={{ name: 'audio/u1.bin', size: 7, type: '' }}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'URL をコピー' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Web URL をコピー/ }))
    expect(copyToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/storage/c/b/rec/?preview=rec%2Fa.tar&entry=audio%2Fu1.bin`,
    )

    await userEvent.click(screen.getByRole('button', { name: 'URL をコピー' }))
    await userEvent.click(screen.getByRole('menuitem', { name: /生データ URL をコピー/ }))
    // 相対パスのままコピーするとホストが分からず、受け取った側が開けない。
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      `${window.location.origin}/api/internal/storage/c/preview/tar-entry?bucket=b&key=a.tar&entry=x`,
    )
  })
})

describe('TarEntryModal - head モード', () => {
  it('本文の取得だけ maxBytes 付き URL を使い、DL / 生データ URL は本体を全部指す', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello'))
    renderEntry('notes.txt')
    await screen.findByText('hello')

    const calls = vi.mocked(api.tarEntryUrl).mock.calls
    // 本文用 (head モード): 5 番目の引数に maxBytes が入る
    expect(calls.some(c => c[4]?.maxBytes === 65536)).toBe(true)
    // DL / <img src> / 生データ URL 用: opts なし
    expect(calls.some(c => c[4] === undefined)).toBe(true)
  })
})

describe('TarEntryModal - size なしのエントリ', () => {
  it('name だけでも開ける (permalink で来たエントリはサイズを引けない)', () => {
    render(
      <TarEntryModal connId="c" bucket="b" archiveKey="a.tar" entry={{ name: 'ghost.bin' }} onClose={() => {}} />,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('ghost.bin')).toBeInTheDocument()
    // サイズ表示 (「7 B」等) は出ない
    expect(screen.queryByText(/^\d+(\.\d+)? [KMG]?B$/)).not.toBeInTheDocument()
  })

  it('size があれば従来どおり表示する', () => {
    render(
      <TarEntryModal connId="c" bucket="b" archiveKey="a.tar" entry={{ name: 'x.bin', size: 7, type: '' }} onClose={() => {}} />,
    )
    expect(screen.getByText('7 B')).toBeInTheDocument()
  })
})

describe('TarEntryModal - 📌 ピン留め', () => {
  function PinsSpy() {
    const { pins } = usePinnedPreviews()
    return <output data-testid="count">{pins.length}</output>
  }

  it('opened tar エントリの 📌 を押すとピンに積まれる (key = archiveKey, entryPath = entry.name)', () => {
    render(
      <PinnedPreviewsProvider>
        <TarEntryModal connId="c" bucket="b" archiveKey="a.tar" entry={{ name: 'file.bin', size: 7, type: '' }} onClose={() => {}} />
        <PinsSpy />
      </PinnedPreviewsProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'ピン留め' }))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })
})
