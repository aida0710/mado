import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../lib/playerDeck'
import { PlayerDeck } from './PlayerDeck'

// jsdom の HTMLMediaElement は play/pause 未実装
beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})

function AddButton({ n }: { n: number }) {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({
      label: `ch${n}`, src: `/audio/ch${n}.wav`, connId: 'c', bucket: 'b', key: `ch${n}.wav`,
    })}>
      add{n}
    </button>
  )
}

function setup() {
  return render(
    <PlayerDeckProvider>
      <AddButton n={1} />
      <AddButton n={2} />
      <PlayerDeck />
    </PlayerDeckProvider>,
  )
}

describe('PlayerDeck', () => {
  it('トラック 0 件では描画されない', () => {
    setup()
    expect(screen.queryByText('同期プレイヤー')).not.toBeInTheDocument()
  })

  it('追加でトラック行が出る / 重複追加は無視', () => {
    setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(screen.getByText(/同期プレイヤー/)).toBeInTheDocument()
    expect(screen.getAllByText('ch1')).toHaveLength(1)
    expect(screen.getByText('ch2')).toBeInTheDocument()
  })

  it('一括再生で全 <audio> の play が呼ばれる', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    fireEvent.click(screen.getByRole('button', { name: '一括再生' }))
    const audios = container.querySelectorAll('audio')
    expect(audios).toHaveLength(2)
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  })

  it('ソロは他トラックをミュートする', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    fireEvent.click(screen.getAllByRole('button', { name: 'ソロ' })[0])
    const audios = [...container.querySelectorAll('audio')]
    expect(audios[0].muted).toBe(false)
    expect(audios[1].muted).toBe(true)
  })

  it('折りたたんでも <audio> はアンマウントされない (再生継続)', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(container.querySelectorAll('audio')).toHaveLength(2)
    fireEvent.click(screen.getByText(/同期プレイヤー/))
    expect(container.querySelectorAll('audio')).toHaveLength(2)
  })

  it('ソロ中トラックの削除で残りのミュートが解除される (幽霊ソロ防止)', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    fireEvent.click(screen.getAllByRole('button', { name: 'ソロ' })[0])
    expect([...container.querySelectorAll('audio')][1].muted).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0])
    const audios = [...container.querySelectorAll('audio')]
    expect(audios).toHaveLength(1)
    expect(audios[0].muted).toBe(false)
  })
})
