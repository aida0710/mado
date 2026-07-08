import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewArchive } from './PreviewArchive'
import { PinnedPreviewsProvider, usePinnedPreviews } from '../lib/pinnedPreviews'

// tarPreview は NDJSON ストリームを内部で組み立てて最終的な TarPreview を
// resolve する関数。ここではストリーミングの中身 (onMode/onEntry/onProgress)
// はテスト対象外なので、完成形をそのまま返すシンプルな mock で十分
// (TarEntryModal.test.tsx と同じ、api/client 丸ごと mock する方針)。
vi.mock('../lib/api/client', () => ({
  api: {
    tarPreview: vi.fn(async () => ({
      entries: [
        { name: 'notes.json', size: 12, type: '' },
        { name: 'blob.bin', size: 34, type: '' },
      ],
      truncated: false,
      hasMore: false,
      offset: 0,
      limit: 10,
    })),
    invalidateTarPreview: vi.fn(),
    lastFetched: { tar: vi.fn(() => null) },
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

function PinsSpy() {
  const { pins } = usePinnedPreviews()
  return <output data-testid="count">{pins.length}</output>
}

describe('PreviewArchive - 行の 📌 ピン留め', () => {
  it('プレビュー可能なエントリ (json) には 📌 ボタンが出て、押すとピンに積まれる', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
        <PinsSpy />
      </PinnedPreviewsProvider>,
    )
    const btn = await screen.findByRole('button', { name: 'notes.json をピン留め' })
    fireEvent.click(btn)
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('unknown 種別 (bin) には 📌 ボタンが出ない', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await screen.findByText('blob.bin')
    expect(screen.queryByRole('button', { name: 'blob.bin をピン留め' })).not.toBeInTheDocument()
  })
})
