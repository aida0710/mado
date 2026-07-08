import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../lib/playerDeck'
import { PlayerDeck } from './PlayerDeck'

// jsdom の HTMLMediaElement は play/pause 未実装
beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})

afterEach(() => vi.unstubAllGlobals())

function AddButton({ n }: { n: number }) {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({
      label: `ch${n}`, connId: 'c', bucket: 'b', key: `ch${n}.wav`,
    })}>
      add{n}
    </button>
  )
}

function AddTarButton() {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({
      label: 'tar-entry', connId: 'c', bucket: 'b', key: 'shard.tar', entryPath: 'u1.wav',
    })}>
      addTar
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
    // 押下状態は aria-pressed で明示される (反転チップ表示の判定と同じソース)
    expect(screen.getAllByRole('button', { name: 'ソロ' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: 'ソロ' })[1]).toHaveAttribute('aria-pressed', 'false')
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

  it('tar 内エントリのトラックは blob 解決後に <audio src> が blob: URL になる (デッキでもシーク不具合対策を適用)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['data'])),
    } as unknown as Response))
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()

    const { container } = render(
      <PlayerDeckProvider>
        <AddTarButton />
        <PlayerDeck />
      </PlayerDeckProvider>,
    )
    fireEvent.click(screen.getByText('addTar'))
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(1))
    expect(container.querySelector('audio')!.src).toContain('blob:')
  })

  it('blob 取得中に一括再生しても、解決後に後着トラックへ play() が呼ばれる (取得中は「取得中…」表示)', async () => {
    let resolveFetch!: (v: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise<Response>(resolve => { resolveFetch = resolve }),
    ))
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()

    const { container } = render(
      <PlayerDeckProvider>
        <AddButton n={1} />
        <AddTarButton />
        <PlayerDeck />
      </PlayerDeckProvider>,
    )
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('addTar'))
    // 取得中: tar トラックの <audio> はまだ無く、行に「取得中…」が出る
    expect(container.querySelectorAll('audio')).toHaveLength(1)
    expect(screen.getByText('取得中…')).toBeInTheDocument()

    // 取得中に一括再生 → マウント済みの 1 本だけ play される
    fireEvent.click(screen.getByRole('button', { name: '一括再生' }))
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFetch({
        ok: true,
        blob: () => Promise.resolve(new Blob(['data'])),
      } as unknown as Response)
    })
    // blob 解決後: 後着トラックがマウントされ、再生中なので play() が追加で呼ばれる
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(2))
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('取得中…')).not.toBeInTheDocument()
  })

  it('後着トラックが tracks 先頭でも、自分以外のマスターに合わせる (合奏の 0 秒巻き戻り防止)', async () => {
    let resolveFetch!: (v: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise<Response>(resolve => { resolveFetch = resolve }),
    ))
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()

    const { container } = render(
      <PlayerDeckProvider>
        <AddButton n={1} />
        <AddTarButton />
        <PlayerDeck />
      </PlayerDeckProvider>,
    )
    // tar (fetch pending) を先に追加 → tracks の先頭スロットが後着になる並び
    fireEvent.click(screen.getByText('addTar'))
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByRole('button', { name: '一括再生' }))

    // wav が 30 秒まで再生済みの状態を再現
    const wav = container.querySelector('audio')!
    wav.currentTime = 30

    await act(async () => {
      resolveFetch({
        ok: true,
        blob: () => Promise.resolve(new Blob(['data'])),
      } as unknown as Response)
    })
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(2))
    const tar = [...container.querySelectorAll('audio')].find(a => a.src.startsWith('blob:'))!
    // 後着 tar は再生中の wav (自分以外のマスター) の時刻に合う。自分をマスターに
    // 選ぶと 0 秒スタート + ドリフト補正が wav を 0 秒へ巻き戻す回帰になる。
    expect(tar.currentTime).toBe(30)
    expect(wav.currentTime).toBe(30)
  })

  it('短いトラックが終了しても masterTime が長いトラックに追従して進む', () => {
    vi.useFakeTimers()
    try {
      const { container } = setup()
      fireEvent.click(screen.getByText('add1'))
      fireEvent.click(screen.getByText('add2'))
      const [a, b] = [...container.querySelectorAll('audio')]

      // a: 長さ1 (先に終わる), b: 長さ3。onLoadedMetadata 経由で durations を埋める。
      Object.defineProperty(a, 'duration', { value: 1, configurable: true })
      Object.defineProperty(b, 'duration', { value: 3, configurable: true })
      fireEvent.loadedMetadata(a)
      fireEvent.loadedMetadata(b)

      fireEvent.click(screen.getByRole('button', { name: '一括再生' }))

      // a は再生し終えて ended、currentTime はその終端 (1) のまま。
      // b はまだ再生中で currentTime=2 まで進んでいる。
      Object.defineProperty(a, 'ended', { value: true, configurable: true })
      a.currentTime = 1
      b.currentTime = 2

      act(() => {
        vi.advanceTimersByTime(1000)
      })

      // masterTime は b (長い方) の 2 秒に追従し、a の終端 (1 秒) には引きずられない。
      expect(screen.getByText('0:02 / 0:03')).toBeInTheDocument()
      // a は無音の 0 パディングとして終端に留まり、0 秒へ巻き戻されない。
      expect(a.currentTime).toBe(1)
      // 本命の回帰ガード: 旧実装は master=a=1 とし computeDriftAdjustments が
      // 長い b を 1 へ引き戻していた。max マスターなら b は自分の 2 秒のまま。
      expect(b.currentTime).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('マスターシークは各トラックを自分の長さでクランプする (終端 = 0 パディング)', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    const [a, b] = [...container.querySelectorAll('audio')]

    // a: 長さ1, b: 長さ3 → maxDuration=3。onLoadedMetadata 経由で durations を埋める。
    Object.defineProperty(a, 'duration', { value: 1, configurable: true })
    Object.defineProperty(b, 'duration', { value: 3, configurable: true })
    fireEvent.loadedMetadata(a)
    fireEvent.loadedMetadata(b)

    // マスターシークを 2 秒へ。a は自分の長さ (1) を超えるので終端でクランプ、
    // b は長さ内なので 2 秒へ。
    fireEvent.change(screen.getByLabelText('マスターシーク'), { target: { value: '2' } })

    expect(a.currentTime).toBe(1)
    expect(b.currentTime).toBe(2)
  })

  it('全トラック終了後に ▶ を押すと頭出し (currentTime=0) してから再生し直す', () => {
    vi.useFakeTimers()
    try {
      const { container } = setup()
      fireEvent.click(screen.getByText('add1'))
      fireEvent.click(screen.getByText('add2'))
      const [a, b] = [...container.querySelectorAll('audio')]

      Object.defineProperty(a, 'duration', { value: 1, configurable: true })
      Object.defineProperty(b, 'duration', { value: 3, configurable: true })
      fireEvent.loadedMetadata(a)
      fireEvent.loadedMetadata(b)

      fireEvent.click(screen.getByRole('button', { name: '一括再生' }))

      // 両トラックとも終端で終了。
      Object.defineProperty(a, 'ended', { value: true, configurable: true })
      Object.defineProperty(b, 'ended', { value: true, configurable: true })
      a.currentTime = 1
      b.currentTime = 3

      act(() => {
        vi.advanceTimersByTime(1000)
      })

      // 全終了 → 停止し、マスター時刻は maxDuration(3) に張り付き ▶ に戻る。
      expect(screen.getByText('0:03 / 0:03')).toBeInTheDocument()
      const playBtn = screen.getByRole('button', { name: '一括再生' })

      const play = window.HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>
      play.mockClear()

      // 全終了状態から ▶ → 両トラックが 0 へ頭出しされてから play が呼ばれる。
      fireEvent.click(playBtn)
      expect(a.currentTime).toBe(0)
      expect(b.currentTime).toBe(0)
      expect(play).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
