import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
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

// 深い階層の tar エントリ。label にはエントリのフルパスが入る (PreviewArchive の流儀)。
function TarLabelButton() {
  const deck = usePlayerDeck()
  return (
    <button onClick={() => deck.addTrack({
      label: 'audio/mic_01_far.wav',
      connId: 'c', bucket: 'b', key: 'rec/session.tar', entryPath: 'audio/mic_01_far.wav',
    })}>
      addDeepTar
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

  it('ソロ中に blob 解決した後着トラックはミュートされる (ソロ漏れ防止)', async () => {
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

    // tar の <audio> がまだ無いうちに ch1 をソロにする
    fireEvent.click(screen.getAllByRole('button', { name: 'ソロ' })[0])
    expect(container.querySelectorAll('audio')).toHaveLength(1)

    await act(async () => {
      resolveFetch({ ok: true, blob: () => Promise.resolve(new Blob(['d'])) } as unknown as Response)
    })
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(2))

    // ミュート反映 effect の依存には「<audio> が生えた」が入っていない。
    // onTrackArrive が明示的に適用しないと、ソロ中でも後着トラックが鳴る。
    const tar = [...container.querySelectorAll('audio')].find(a => a.src.startsWith('blob:'))!
    expect(tar.muted).toBe(true)
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

  it('トラック波形クリックで全トラックがその時刻へシークする', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    const [a, b] = [...container.querySelectorAll('audio')]

    // a: 長さ1, b: 長さ3 → maxDuration=3。onLoadedMetadata 経由で durations を埋める。
    Object.defineProperty(a, 'duration', { value: 1, configurable: true })
    Object.defineProperty(b, 'duration', { value: 3, configurable: true })
    fireEvent.loadedMetadata(a)
    fireEvent.loadedMetadata(b)

    // 1 本目のトラック波形 (canvas role="slider", aria-label で master seek の
    // range と区別) を全幅 100px の中央 (clientX=50) でクリック → ratio=0.5。
    const waveforms = screen.getAllByRole('slider', { name: '再生位置' })
    vi.spyOn(waveforms[0], 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 100, top: 0, height: 28, right: 100, bottom: 28, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    )
    fireEvent.click(waveforms[0], { clientX: 50 })

    // seekAll(0.5 * 3 = 1.5): a は自分の長さ (1) でクランプ、b は 1.5 秒へ。
    // どのトラックの波形をクリックしても全トラックが同じマスター時刻へ揃う。
    expect(a.currentTime).toBe(1)
    expect(b.currentTime).toBe(1.5)
    expect(screen.getByText('0:01 / 0:03')).toBeInTheDocument()
  })

  it('tar トラックのラベルは basename を出し、title / コピーはフルパス (アーカイブ › エントリ)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['data'])),
    } as unknown as Response))
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()

    render(
      <PlayerDeckProvider>
        <TarLabelButton />
        <PlayerDeck />
      </PlayerDeckProvider>,
    )
    fireEvent.click(screen.getByText('addDeepTar'))
    // label = 'audio/mic_01_far.wav' (エントリのフルパス) だが、w-56 の枠で切れて
    // 肝心のファイル名が読めなくなるので basename だけを出す。
    expect(await screen.findByText('mic_01_far.wav')).toBeInTheDocument()
    expect(screen.getByTitle('rec/session.tar › audio/mic_01_far.wav')).toBeInTheDocument()
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

// ── L / R チャンネル ──────────────────────────────────────────────
// jsdom に AudioContext は無い。この describe だけローカルに stub する
// (vitest.setup.ts は汚さない) — 上の既存ケースは L/R を押さないので
// グラフが構築されず、AudioContext 無しのまま通ることも同時に担保している。

function mockAnalyze(channels: number | null) {
  return vi.spyOn(api, 'mediaAnalyze').mockResolvedValue({
    cacheKey: 'k', peaks: [], durationSec: 1, sampleRate: 16000, hasSpectrogram: false,
    meta: {
      codec: null, container: null, channels,
      bitsPerSample: null, bitRate: null, sizeBytes: null, peakDb: null, rmsDb: null,
    },
  })
}

// splitter → merger のエッジ [出力ch, 入力ch] と、source の行き先を記録する AudioContext。
function installMockAudioContext() {
  const splitterEdges: Array<[number, number]> = []
  const gainSetTarget = vi.fn()
  const sourceCount = { n: 0 }
  const closed = { n: 0 }
  const resumed = { n: 0 }
  // source が今どのノードへ繋がっているか ('gain' | 'splitter')。both は gain 直結。
  const sourceTarget = { name: null as string | null }

  class MockAudioContext {
    currentTime = 0
    destination = {}
    // ノードの同一性を見るための目印。
    private splitter = {
      __kind: 'splitter',
      connect: vi.fn((_target: unknown, from: number, to: number) => { splitterEdges.push([from, to]) }),
      // 実装は張り替えのたびに disconnect() してから張り直す。
      disconnect: vi.fn(() => { splitterEdges.length = 0 }),
    }
    private gain = {
      __kind: 'gain',
      gain: { setTargetAtTime: gainSetTarget },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }
    createMediaElementSource = vi.fn(() => {
      sourceCount.n++
      return {
        connect: vi.fn((target: { __kind?: string }) => { sourceTarget.name = target.__kind ?? null }),
        disconnect: vi.fn(() => { sourceTarget.name = null }),
      }
    })
    createChannelSplitter = vi.fn(() => this.splitter)
    createChannelMerger = vi.fn(() => ({ __kind: 'merger', connect: vi.fn(), disconnect: vi.fn() }))
    createGain = vi.fn(() => this.gain)
    resume = vi.fn(() => { resumed.n++; return Promise.resolve() })
    close = vi.fn(() => { closed.n++; return Promise.resolve() })
  }
  vi.stubGlobal('AudioContext', MockAudioContext)
  return { splitterEdges, sourceTarget, gainSetTarget, sourceCount, closed, resumed }
}

const leftBtn = () => screen.getByRole('button', { name: '左チャンネル' })
const rightBtn = () => screen.getByRole('button', { name: '右チャンネル' })

describe('PlayerDeck - L/R チャンネル', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('既定は両チャンネル (L も R も非押下)', async () => {
    installMockAudioContext()
    mockAnalyze(2)
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())
    expect(leftBtn()).toHaveAttribute('aria-pressed', 'false')
    expect(rightBtn()).toHaveAttribute('aria-pressed', 'false')
  })

  it('L 押下で左 ch を左右へ複製し、グラフはそのとき初めて 1 回だけ作られる', async () => {
    const { splitterEdges, sourceCount, resumed } = installMockAudioContext()
    mockAnalyze(2)
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())

    // 押すまでは <audio> のネイティブ出力のまま (退行防止の肝)
    expect(sourceCount.n).toBe(0)

    fireEvent.click(leftBtn())
    expect(sourceCount.n).toBe(1)
    expect(resumed.n).toBe(1) // gesture 内で resume する
    expect(splitterEdges).toEqual([[0, 0], [0, 1]])
    expect(leftBtn()).toHaveAttribute('aria-pressed', 'true')
    expect(rightBtn()).toHaveAttribute('aria-pressed', 'false')
    // グラフへ移したトラックの要素側 muted は必ず解除される (二重消音の防止)
    expect(container.querySelector('audio')!.muted).toBe(false)
  })

  it('同じ L をもう一度押すと both に戻り、splitter を通らなくなる', async () => {
    const { splitterEdges, sourceTarget, sourceCount } = installMockAudioContext()
    mockAnalyze(2)
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())

    fireEvent.click(leftBtn())
    expect(sourceTarget.name).toBe('splitter')

    fireEvent.click(leftBtn())
    // 回帰ガード: both で splitter を通すと、モノラル音源では output 1 が無音になり
    // 右チャンネルが恒久的に死ぬ。both は source を gain へ直結する。
    expect(sourceTarget.name).toBe('gain')
    expect(splitterEdges).toEqual([])
    expect(leftBtn()).toHaveAttribute('aria-pressed', 'false')
    // createMediaElementSource は 1 要素 1 回きり。2 回目は張り替えだけ。
    expect(sourceCount.n).toBe(1)
  })

  it('L がアクティブなときに R を押すと right になる (both を経由しない)', async () => {
    const { splitterEdges } = installMockAudioContext()
    mockAnalyze(2)
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())

    fireEvent.click(leftBtn())
    fireEvent.click(rightBtn())
    expect(splitterEdges).toEqual([[1, 0], [1, 1]])
    expect(leftBtn()).toHaveAttribute('aria-pressed', 'false')
    expect(rightBtn()).toHaveAttribute('aria-pressed', 'true')
  })

  it('モノラルファイルでは L/R が無効になり、理由が title に出る', async () => {
    installMockAudioContext()
    mockAnalyze(1)
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeDisabled())
    expect(rightBtn()).toBeDisabled()
    expect(leftBtn()).toHaveAttribute('title', 'モノラルのため分割できません')
  })

  it('チャンネル数が不明 (meta=null) なら L/R は有効のまま', async () => {
    installMockAudioContext()
    vi.spyOn(api, 'mediaAnalyze').mockResolvedValue({
      cacheKey: 'k', peaks: [], durationSec: 1, sampleRate: 16000, hasSpectrogram: false, meta: null,
    })
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())
  })

  it('解析が返るまでは L/R を押させない (mono で R を押して無音になるのを防ぐ)', async () => {
    installMockAudioContext()
    vi.spyOn(api, 'mediaAnalyze').mockReturnValue(new Promise(() => { /* 未解決 */ }))
    setup()
    fireEvent.click(screen.getByText('add1'))
    expect(leftBtn()).toBeDisabled()
    expect(leftBtn()).toHaveAttribute('title', 'チャンネル数を調べています')
  })

  it('解析に失敗しても L/R は有効になる (永久に「調べています」で止まらない)', async () => {
    installMockAudioContext()
    vi.spyOn(api, 'mediaAnalyze').mockRejectedValue(new Error('media-worker down'))
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())
  })

  it('tar エントリは blob 取得が終わるまで L/R が無効 (<audio> が無くグラフを作れない)', async () => {
    installMockAudioContext()
    mockAnalyze(2)
    let resolveFetch!: (v: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise<Response>(resolve => { resolveFetch = resolve }),
    ))
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()

    render(
      <PlayerDeckProvider>
        <AddTarButton />
        <PlayerDeck />
      </PlayerDeckProvider>,
    )
    fireEvent.click(screen.getByText('addTar'))
    expect(leftBtn()).toBeDisabled()
    expect(leftBtn()).toHaveAttribute('title', '取得中')

    await act(async () => {
      resolveFetch({ ok: true, blob: () => Promise.resolve(new Blob(['d'])) } as unknown as Response)
    })
    await waitFor(() => expect(leftBtn()).toBeEnabled())
  })

  it('グラフ化後のミュートは要素の muted ではなく gain で行う', async () => {
    const { gainSetTarget } = installMockAudioContext()
    mockAnalyze(2)
    const { container } = setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())

    fireEvent.click(leftBtn())
    gainSetTarget.mockClear()

    fireEvent.click(screen.getAllByRole('button', { name: 'ミュート' })[0])
    // gain を 0 へ (10ms の時定数)。<audio>.muted は触らない —
    // MediaElementAudioSourceNode 経由で効くかがブラウザ実装依存なため。
    expect(gainSetTarget).toHaveBeenCalledWith(0, 0, 0.01)
    expect(container.querySelector('audio')!.muted).toBe(false)
  })

  it('「クリア」で AudioContext を閉じ、次に L を押したら新しい ctx を作り直す', async () => {
    const { closed, sourceCount } = installMockAudioContext()
    mockAnalyze(2)
    setup()
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())
    fireEvent.click(leftBtn())

    fireEvent.click(screen.getByText('クリア'))
    expect(closed.n).toBe(1)

    // close 済みの ctx ではノードを作れない。再追加 → L で新しい ctx が立ち上がる。
    fireEvent.click(screen.getByText('add1'))
    await waitFor(() => expect(leftBtn()).toBeEnabled())
    fireEvent.click(leftBtn())
    expect(sourceCount.n).toBe(2)
    expect(leftBtn()).toHaveAttribute('aria-pressed', 'true')
  })

  it('AudioContext 非対応のブラウザでは L/R ボタンを描画しない', () => {
    vi.unstubAllGlobals() // jsdom の既定 = AudioContext なし
    mockAnalyze(2)
    setup()
    fireEvent.click(screen.getByText('add1'))
    expect(screen.queryByRole('button', { name: '左チャンネル' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '右チャンネル' })).not.toBeInTheDocument()
    // ミュート / ソロは従来どおり出る
    expect(screen.getByRole('button', { name: 'ミュート' })).toBeInTheDocument()
  })
})
