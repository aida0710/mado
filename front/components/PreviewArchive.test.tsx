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
    // 本物と同じく **相対パス** を返す。絶対 URL を返すモックだと
    // 「生データ URL のコピーに origin が付いていない」バグを見逃す。
    tarEntryUrl: vi.fn(() => '/api/internal/storage/c/preview/tar-entry?bucket=b&key=a.tar&entry=x'),
    // モーダル本文はスニッフ経由で取得される。
    readHead: vi.fn(async () => new TextEncoder().encode('entry body')),
  },
}))
vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { copyToClipboard } from '../lib/clipboard'

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

  it('unknown 種別 (bin) にもピン留めが出る (デッキに追加は音声のみ)', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('blob.bin')
    expect(screen.getByRole('menuitem', { name: 'このエントリをダウンロード' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'ピン留め' })).toBeInTheDocument()
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

  it('Web URL / 生データ URL のコピー項目が並ぶ', async () => {
    render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="rec/a.tar" />
      </PinnedPreviewsProvider>,
    )
    await openMenuFor('track.mp3')

    await userEvent.click(screen.getByRole('menuitem', { name: /Web URL をコピー/ }))
    // 親ディレクトリのリスト + ?preview=<tar> + &entry=<エントリ> の共有 URL。
    expect(copyToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/storage/c/b/rec/?preview=rec%2Fa.tar&entry=track.mp3`,
    )

    await openMenuFor('track.mp3')
    await userEvent.click(screen.getByRole('menuitem', { name: /生データ URL をコピー/ }))
    // 相対パスのままコピーするとホストが分からず、受け取った側が開けない。
    expect(copyToClipboard).toHaveBeenLastCalledWith(
      `${window.location.origin}/api/internal/storage/c/preview/tar-entry?bucket=b&key=a.tar&entry=x`,
    )
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

describe('PreviewArchive - URL 駆動のエントリ開閉 (?entry=)', () => {
  function renderUrlDriven(props: {
    initialEntry?: string | null
    onEntryChange?: (e: string | null) => void
  }) {
    return render(
      <PinnedPreviewsProvider>
        <PreviewArchive connId="c" bucket="b" k="a.tar" {...props} />
      </PinnedPreviewsProvider>,
    )
  }

  it('initialEntry のモーダルがマウント時に開く', async () => {
    renderUrlDriven({ initialEntry: 'notes.json', onEntryChange: vi.fn() })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('notes.json')).toBeInTheDocument()
  })

  it('今のページに載っていないエントリでも名前だけで開ける (permalink の核心)', async () => {
    // ページングされた一覧に 'ghost.bin' は無いが、共有 URL からは直接開ける。
    // 本文は name から自前でフェッチするので size / type は無くてよい。
    renderUrlDriven({ initialEntry: 'deep/ghost.bin', onEntryChange: vi.fn() })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('deep/ghost.bin')).toBeInTheDocument()
    // サイズは引けないので表示しない (「7 B」のような行が出ない)。
    expect(within(dialog).queryByText(/\d+ B$/)).not.toBeInTheDocument()
  })

  it('行クリックで onEntryChange(name)、✕ で onEntryChange(null) を呼ぶ', async () => {
    const onEntryChange = vi.fn()
    renderUrlDriven({ initialEntry: null, onEntryChange })

    await userEvent.click(await screen.findByText('blob.bin'))
    expect(onEntryChange).toHaveBeenCalledWith('blob.bin')
    // initialEntry が真実源なので、URL が返ってくるまでモーダルは開かない
    // (呼び出し側が ?entry= を push → 再レンダで initialEntry が入る)。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    onEntryChange.mockClear()
    renderUrlDriven({ initialEntry: 'blob.bin', onEntryChange })
    await userEvent.click(await screen.findByRole('button', { name: 'Close entry' }))
    expect(onEntryChange).toHaveBeenCalledWith(null)
  })

  it('onEntryChange が無いとき (ピンカード) は initialEntry を無視し、行クリックでローカルに開く', async () => {
    // ピンカードは <Routes> の外に居る。URL の ?entry= に反応してしまうと、
    // 無関係な tar の permalink を開いただけでピン留め済みカードのモーダルが開く。
    renderUrlDriven({ initialEntry: 'notes.json' })
    await screen.findByText('notes.json')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('blob.bin'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('blob.bin')).toBeInTheDocument()
  })
})
