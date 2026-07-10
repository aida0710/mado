import { describe, expect, it, vi } from 'vitest'
import {
  canSplitChannels,
  channelRouting,
  createTrackAudioGraph,
  getAudioContextCtor,
  nextChannelMode,
} from './deckAudioGraph'

describe('channelRouting', () => {
  it('left は左 ch を左右へ複製する (片耳だけにならない)', () => {
    expect(channelRouting('left')).toEqual([[0, 0], [0, 1]])
  })

  it('right は右 ch を左右へ複製する', () => {
    expect(channelRouting('right')).toEqual([[1, 0], [1, 1]])
  })
})

describe('nextChannelMode', () => {
  it('both から押したボタンのチャンネルへ', () => {
    expect(nextChannelMode('both', 'left')).toBe('left')
    expect(nextChannelMode('both', 'right')).toBe('right')
  })

  it('同じボタンをもう一度押すと both に戻る', () => {
    expect(nextChannelMode('left', 'left')).toBe('both')
    expect(nextChannelMode('right', 'right')).toBe('both')
  })

  it('L 中に R を押すと right に切り替わる (both を経由しない)', () => {
    expect(nextChannelMode('left', 'right')).toBe('right')
    expect(nextChannelMode('right', 'left')).toBe('left')
  })
})

describe('canSplitChannels', () => {
  it('モノラルは分割できない', () => {
    expect(canSplitChannels(1)).toBe(false)
  })

  it('ステレオ以上は分割できる (3ch 以上は先頭 2ch を使う)', () => {
    expect(canSplitChannels(2)).toBe(true)
    expect(canSplitChannels(6)).toBe(true)
  })

  it('不明 (null / undefined) は有効側にフォールバックする', () => {
    // 旧 API は meta ごと null を返しうる。ここで false に倒すと実ステレオまで
    // L/R を失う。true に倒して外れても実害は「mono で R が無音」だけ。
    expect(canSplitChannels(null)).toBe(true)
    expect(canSplitChannels(undefined)).toBe(true)
  })
})

// ── createTrackAudioGraph ─────────────────────────────────────────
// jsdom に AudioContext は無いので、connect/disconnect を記録する fake で
// 接続トポロジそのものを検証する。

interface Edge { target: unknown; output?: number; input?: number }

class FakeNode {
  edges: Edge[] = []
  disconnectCount = 0
  connect(target: unknown, output?: number, input?: number): unknown {
    this.edges.push({ target, output, input })
    return target
  }
  disconnect(): void {
    this.edges = []
    this.disconnectCount++
  }
}

function fakeCtx() {
  const setTargetAtTime = vi.fn()
  const destination = new FakeNode()
  const source = new FakeNode()
  const splitter = new FakeNode()
  const merger = new FakeNode()
  const gain = Object.assign(new FakeNode(), { gain: { setTargetAtTime } })
  const ctx = {
    currentTime: 0,
    destination,
    createMediaElementSource: vi.fn(() => source),
    createChannelSplitter: vi.fn(() => splitter),
    createChannelMerger: vi.fn(() => merger),
    createGain: vi.fn(() => gain),
  }
  return { ctx, source, splitter, merger, gain, destination, setTargetAtTime }
}

function build(initialMode: Parameters<typeof createTrackAudioGraph>[2] = 'both') {
  const f = fakeCtx()
  const el = {} as HTMLMediaElement
  const graph = createTrackAudioGraph(f.ctx as unknown as AudioContext, el, initialMode)
  return { ...f, el, graph }
}

// splitter → merger のエッジを [出力ch, 入力ch] の配列に均す。
function splitterEdges(splitter: FakeNode, merger: FakeNode): Array<[number, number]> {
  return splitter.edges
    .filter(e => e.target === merger)
    .map(e => [e.output as number, e.input as number])
}

// source の行き先ノード一覧。
function sourceTargets(source: FakeNode): unknown[] {
  return source.edges.map(e => e.target)
}

describe('createTrackAudioGraph', () => {
  it('merger → gain → destination は常に張られる', () => {
    const { ctx, merger, gain, destination, el } = build()
    expect(ctx.createMediaElementSource).toHaveBeenCalledExactlyOnceWith(el)
    expect(merger.edges).toEqual([{ target: gain, output: undefined, input: undefined }])
    expect(gain.edges).toEqual([{ target: destination, output: undefined, input: undefined }])
  })

  it('both は splitter を通さず source を gain へ直結する', () => {
    // 回帰ガード: splitter は discrete 解釈なのでモノラル入力だと output 1 が無音になり、
    // both を [0→0, 1→1] で組むと右チャンネルが恒久的に死ぬ。直結ならチャンネル数に
    // 関わらずネイティブ再生と同じ出力になる。
    const { source, splitter, merger, gain } = build('both')
    expect(sourceTargets(source)).toEqual([gain])
    expect(sourceTargets(source)).not.toContain(splitter)
    expect(splitterEdges(splitter, merger)).toEqual([])
  })

  it('left / right は source を splitter へ通す', () => {
    const l = build('left')
    expect(sourceTargets(l.source)).toEqual([l.splitter])
    expect(splitterEdges(l.splitter, l.merger)).toEqual([[0, 0], [0, 1]])

    const r = build('right')
    expect(sourceTargets(r.source)).toEqual([r.splitter])
    expect(splitterEdges(r.splitter, r.merger)).toEqual([[1, 0], [1, 1]])
  })

  it('left → both に戻すと splitter が外れ、右チャンネルが復活する', () => {
    const { graph, source, splitter, merger, gain } = build('left')
    graph.setChannel('both')
    expect(sourceTargets(source)).toEqual([gain])
    expect(splitterEdges(splitter, merger)).toEqual([])
  })

  it('setChannel は source と splitter のエッジだけを張り替える (下流は触らない)', () => {
    const { graph, splitter, merger, gain, destination } = build('both')
    const disconnectsBefore = splitter.disconnectCount

    graph.setChannel('left')

    expect(splitter.disconnectCount).toBe(disconnectsBefore + 1)
    expect(splitterEdges(splitter, merger)).toEqual([[0, 0], [0, 1]])
    // merger → gain → destination は張り直されない (ミュート状態が保たれる根拠)
    expect(merger.edges).toEqual([{ target: gain, output: undefined, input: undefined }])
    expect(gain.edges).toEqual([{ target: destination, output: undefined, input: undefined }])
  })

  it('setChannel を繰り返してもエッジは張りっぱなしにならない', () => {
    const { graph, source, splitter, merger, gain } = build('both')
    graph.setChannel('left')
    graph.setChannel('right')
    expect(splitterEdges(splitter, merger)).toEqual([[1, 0], [1, 1]])
    graph.setChannel('both')
    expect(splitterEdges(splitter, merger)).toEqual([])
    expect(sourceTargets(source)).toEqual([gain])
  })

  it('setMuted は gain を 10ms の時定数で 0 / 1 へ寄せる (プチノイズ回避)', () => {
    const { graph, setTargetAtTime } = build()
    graph.setMuted(true)
    expect(setTargetAtTime).toHaveBeenCalledWith(0, 0, 0.01)
    graph.setMuted(false)
    expect(setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.01)
  })

  it('dispose は全ノードを切り離す', () => {
    const { graph, source, splitter, merger, gain } = build()
    graph.dispose()
    expect(source.edges).toEqual([])
    expect(merger.edges).toEqual([])
    expect(gain.edges).toEqual([])
    expect(splitter.disconnectCount).toBeGreaterThan(0)
  })
})

describe('getAudioContextCtor', () => {
  it('window に AudioContext が無ければ undefined (jsdom の既定)', () => {
    expect(getAudioContextCtor()).toBeUndefined()
  })

  it('呼び出しのたびに window を読む (module top-level で束縛しない)', () => {
    const Fake = class {} as unknown as new () => AudioContext
    vi.stubGlobal('AudioContext', Fake)
    expect(getAudioContextCtor()).toBe(Fake)
    vi.unstubAllGlobals()
    expect(getAudioContextCtor()).toBeUndefined()
  })
})
