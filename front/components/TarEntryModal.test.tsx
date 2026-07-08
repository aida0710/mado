import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TarEntryModal } from './TarEntryModal'
import { PinnedPreviewsProvider, usePinnedPreviews } from '../lib/pinnedPreviews'

vi.mock('../lib/api/client', () => ({
  api: {
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    tarEntryText: vi.fn(async () => ''),
  },
}))
vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

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
    vi.mocked(api.tarEntryText).mockResolvedValue('{"a":1}')
    renderEntry('x.json')
    // テキスト読み込み後にコピーボタンが現れる
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })

  it('copies the raw text of a .jsonl entry (no pretty-print)', async () => {
    vi.mocked(api.tarEntryText).mockResolvedValue('{"a":1}\n{"b":2}')
    renderEntry('x.jsonl')
    const btn = await screen.findByRole('button', { name: '内容をコピー' })
    await userEvent.click(btn)
    expect(copyToClipboard).toHaveBeenCalledWith('{"a":1}\n{"b":2}')
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
