import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../lib/playerDeck'
import { PinnedPreviewsProvider, usePinnedPreviews } from '../lib/pinnedPreviews'
import { BottomDock } from './BottomDock'

// jsdom の HTMLMediaElement は play/pause 未実装 (PlayerDeck.test.tsx と同じ対策)
beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})

function AddTrackButton() {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({ label: 'ch1', connId: 'c', bucket: 'b', key: 'ch1.wav' })}>
      addTrack
    </button>
  )
}

// key はプレビュー非対応 (unknown) の拡張子にして、カード本体が fetch を伴う
// プレビューを描画しないようにする (PreviewDrawer.test.tsx の 'file.xyz' と同じ発想)。
function AddPinButton({ k = 'x.bin' }: { k?: string }) {
  const { addPin } = usePinnedPreviews()
  return (
    <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: k })}>
      addPin:{k}
    </button>
  )
}

function setup(extra?: React.ReactNode) {
  return render(
    <PlayerDeckProvider>
      <PinnedPreviewsProvider>
        <AddTrackButton />
        <AddPinButton />
        {extra}
        <BottomDock />
      </PinnedPreviewsProvider>
    </PlayerDeckProvider>,
  )
}

describe('BottomDock - 表示分岐', () => {
  it('デッキ 0 トラック & ピン 0 件では何も描画しない', () => {
    setup()
    expect(document.querySelector('.fixed')).toBeNull()
    expect(screen.queryByText(/同期プレイヤー/)).not.toBeInTheDocument()
    expect(screen.queryByText(/ピン留め \(/)).not.toBeInTheDocument()
  })

  it('デッキのみ: プレイヤーセクションだけが出る', () => {
    setup()
    fireEvent.click(screen.getByText('addTrack'))
    expect(screen.getByText(/同期プレイヤー/)).toBeInTheDocument()
    expect(screen.queryByText(/ピン留め \(/)).not.toBeInTheDocument()
  })

  it('ピンのみ: ピン留めセクションだけが出る', () => {
    setup()
    fireEvent.click(screen.getByText('addPin:x.bin'))
    expect(screen.getByText(/ピン留め \(1\)/)).toBeInTheDocument()
    expect(screen.queryByText(/同期プレイヤー/)).not.toBeInTheDocument()
  })

  it('両方あるときは 2 セクションが単一の fixed コンテナに同居する', () => {
    setup()
    fireEvent.click(screen.getByText('addTrack'))
    fireEvent.click(screen.getByText('addPin:x.bin'))
    expect(screen.getByText(/同期プレイヤー/)).toBeInTheDocument()
    expect(screen.getByText(/ピン留め \(1\)/)).toBeInTheDocument()
    // fixed 要素の二重スタックはしない
    expect(document.querySelectorAll('.fixed')).toHaveLength(1)
  })
})

describe('BottomDock - ピンセクション操作', () => {
  it('カードがグリッドに描画され、「全部外す」で全ピンが消える (デッキ 0 ならドックごと消える)', () => {
    setup(<AddPinButton k="y.bin" />)
    fireEvent.click(screen.getByText('addPin:x.bin'))
    fireEvent.click(screen.getByText('addPin:y.bin'))
    expect(screen.getByText(/ピン留め \(2\)/)).toBeInTheDocument()
    expect(screen.getAllByText(/プレビュー非対応/)).toHaveLength(2)
    fireEvent.click(screen.getByText('全部外す'))
    expect(document.querySelector('.fixed')).toBeNull()
  })

  it('折りたたみトグルでカードが隠れる (ヘッダは残る)', () => {
    setup()
    fireEvent.click(screen.getByText('addPin:x.bin'))
    expect(screen.getByText(/プレビュー非対応/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/ピン留め \(1\)/))
    expect(screen.queryByText(/プレビュー非対応/)).not.toBeInTheDocument()
    expect(screen.getByText(/ピン留め \(1\)/)).toBeInTheDocument()
    // 再展開で戻る
    fireEvent.click(screen.getByText(/ピン留め \(1\)/))
    expect(screen.getByText(/プレビュー非対応/)).toBeInTheDocument()
  })

  it('カードの ✕ で個別に外れる', () => {
    setup()
    fireEvent.click(screen.getByText('addPin:x.bin'))
    fireEvent.click(screen.getByRole('button', { name: /ピン留めを解除/ }))
    expect(document.querySelector('.fixed')).toBeNull()
  })
})
