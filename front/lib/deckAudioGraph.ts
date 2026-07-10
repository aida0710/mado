// デッキのトラック 1 本分のチャンネルルーティング。ステレオ音声の左右どちらか
// だけを (左右両方のスピーカーから) 聴くために Web Audio のノードグラフを組む。
//
// デッキ本体は <audio> 要素をそのまま鳴らしている。<audio> にはチャンネルを
// 選ぶ手段が無いので、L/R を使うトラックだけ AudioContext 経由に切り替える。
// 純ロジック (channelRouting / nextChannelMode / canSplitChannels) を分けてあるのは
// jsdom に AudioContext が無く、コンポーネントテストからは検証しづらいため
// (driftSync.ts と同じ方針)。

export type ChannelMode = 'both' | 'left' | 'right'
export type ChannelSide = 'left' | 'right'

// splitter の出力 ch → merger の入力 ch。選んだ ch を左右の両方へ複製する
// (= モノラル化) — 片耳だけ鳴ると聴き比べにならないため。
//
// both がここに無いのは意図的。both は splitter を通さず source を gain へ直結する
// (createTrackAudioGraph 参照)。
const ROUTING: Record<ChannelSide, ReadonlyArray<readonly [number, number]>> = {
  left: [[0, 0], [0, 1]],
  right: [[1, 0], [1, 1]],
}

export function channelRouting(side: ChannelSide): ReadonlyArray<readonly [number, number]> {
  return ROUTING[side]
}

// 押されたボタンから次のモードを決める。既にそのチャンネルなら both に戻す
// (L を押す → 左だけ / もう一度 L → 両方 / L 中に R → 右だけ)。
export function nextChannelMode(current: ChannelMode, pressed: ChannelSide): ChannelMode {
  return current === pressed ? 'both' : pressed
}

// splitter で L/R を取り出せるか。ChannelSplitterNode は既定で
// channelCount=2 / explicit / discrete なので、モノラル入力は output 1 が
// 無音になり「R」を選んでも何も鳴らない → mono では L/R を使わせない。
//
// channels が null (ffprobe が返さない / 旧 API で meta 全体が null / 解析に失敗)
// のときは true にフォールバックする。false に倒すと実ステレオまで機能を失う。
// 外したときの実害は「mono で R を選ぶと無音」だけで、もう一度 R を押して both に
// 戻せば直る (both は splitter を通らないため)。
export function canSplitChannels(channels: number | null | undefined): boolean {
  if (channels == null) return true
  return channels >= 2
}

export interface TrackAudioGraph {
  setChannel(mode: ChannelMode): void
  setMuted(muted: boolean): void
  dispose(): void
}

// both:        source → gain → destination
// left/right:  source → splitter(2) → merger(2) → gain → destination
//
// merger→gain / gain→destination は張りっぱなしで、モード切替は source の行き先と
// splitter→merger のエッジだけを張り替える。gain (ミュート) の状態はチャンネル切替を
// またいで保たれる。
//
// **both で splitter を通してはいけない。** ChannelSplitterNode は discrete 解釈なので
// モノラル入力では output 1 が常に無音になり、both の [0→0, 1→1] が右チャンネルを
// 殺してしまう。createMediaElementSource は不可逆なので、一度こうなるとトラックを
// 削除して追加し直すまで右耳が戻らない。source を gain へ直結すれば、チャンネル数に
// 関わらずネイティブ再生と同じ出力になる (3ch 以上も先頭 2ch に切り詰められない)。
//
// 注意: createMediaElementSource() は 1 つの要素につき 1 回しか呼べず、呼んだ
// 瞬間からその <audio> のネイティブ出力は AudioContext 経由に切り替わって
// 後戻りできない。呼び出し側は「ユーザーが L/R を押した時」にだけこれを作ること。
export function createTrackAudioGraph(
  ctx: AudioContext,
  el: HTMLMediaElement,
  initialMode: ChannelMode,
): TrackAudioGraph {
  const source = ctx.createMediaElementSource(el)
  const splitter = ctx.createChannelSplitter(2)
  const merger = ctx.createChannelMerger(2)
  const gain = ctx.createGain()

  merger.connect(gain)
  gain.connect(ctx.destination)

  const setChannel = (mode: ChannelMode): void => {
    // source と splitter 発のエッジを切ってから張り直す。merger より下流は触らない。
    // both のとき merger は無入力になるが、無音を足すだけなので害はない。
    source.disconnect()
    splitter.disconnect()
    if (mode === 'both') {
      source.connect(gain)
      return
    }
    source.connect(splitter)
    for (const [from, to] of channelRouting(mode)) splitter.connect(merger, from, to)
  }
  setChannel(initialMode)

  return {
    setChannel,
    // グラフを持つトラックのミュートは gain が唯一の担当。要素の muted は
    // MediaElementAudioSourceNode 経由で効くかがブラウザ実装依存なので使わない。
    // 0/1 を即代入すると切れ目でプチノイズが出るため 10ms の時定数で寄せる。
    setMuted(muted: boolean): void {
      gain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01)
    },
    dispose(): void {
      source.disconnect()
      splitter.disconnect()
      merger.disconnect()
      gain.disconnect()
    },
  }
}

type AudioContextCtor = new () => AudioContext

// AudioContext のコンストラクタ (Safari は webkit prefix)。未対応なら undefined。
// 呼ぶたびに window を読む — モジュール top-level で束縛すると、テストが render
// 前に差し込む vi.stubGlobal('AudioContext', ...) が間に合わない。
export function getAudioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext ?? w.webkitAudioContext
}
