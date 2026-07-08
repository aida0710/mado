import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
        { name: 'track.mp3', size: 99, type: '' },
        { name: 'blob.bin', size: 34, type: '' },
      ],
      truncated: false,
      hasMore: false,
      offset: 0,
      limit: 10,
    })),
    invalidateTarPreview: vi.fn(),
    lastFetched: { tar: vi.fn(() => null) },
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

function PinsSpy() {
  const { pins } = usePinnedPreviews()
  return <output data-testid="count">{pins.length}</output>
}

// エントリ名のセルから行 (<tr>) を辿り、その行内の ⋯ トリガーを開く。
async function openMenuFor(entryName: string) {
  const nameCell = await screen.findByText(entryName)
  const row = nameCell.closest('tr')
  if (!row) throw new Error(`row not found for ${entryName}`)
  const trigger = within(row).getByRole('button', { name: 'アクション' })
  await userEvent.click(trigger)
  return row
}

describe('PreviewArchive - 行の ⋯ アクションメニュー', () => {
  it('音声エントリ (mp3) にはデッキに追加・ピン留め・ダウンロードが揃う', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('track.mp3')
    expect(screen.getByRole('menuitem', { name: 'デッキに追加' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'ピン留め' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
  })

  it('json エントリにはピン留め・ダウンロードのみ (デッキに追加は出ない)', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('notes.json')
    expect(screen.getByRole('menuitem', { name: 'ピン留め' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'デッキに追加' })).not.toBeInTheDocument()
  })

  it('unknown 種別 (bin) にはピン留め・デッキに追加が出ずダウンロードのみ', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('blob.bin')
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'ピン留め' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'デッキに追加' })).not.toBeInTheDocument()
  })

  it('ピン留めを選ぶとピンに積まれる', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
        <PinsSpy />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('notes.json')
    await userEvent.click(screen.getByRole('menuitem', { name: 'ピン留め' }))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('⋯ トリガーのクリックではエントリのモーダルは開かない', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('notes.json')
    // TarEntryModal は role="dialog" で描画される。行クリックのみで開くはずなので
    // ⋯ トリガーをクリックしただけでは出現しない。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('⋯ トリガーに focus して Enter を押しても行のモーダルは開かない', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    const nameCell = await screen.findByText('notes.json')
    const row = nameCell.closest('tr')
    if (!row) throw new Error('row not found')
    const trigger = within(row).getByRole('button', { name: 'アクション' })
    trigger.focus()
    // 行 (<tr>) の onKeyDown は Enter で setOpenedEntry する。⋯ の keydown が
    // 伝播すると誤ってモーダルが開くので、伝播しないこと (dialog 非出現) を検証。
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Enter でメニュー自体は開く (native button の click が発火する)。
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
  })
})
