import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  canSplitChannels,
  createTrackAudioGraph,
  getAudioContextCtor,
  nextChannelMode,
  type ChannelMode,
  type ChannelSide,
  type TrackAudioGraph,
} from '../lib/deckAudioGraph'
import { computeDriftAdjustments, masterTimeOf } from '../lib/driftSync'
import { basename, fullEntryLabel } from '../lib/format'
import { usePlayerDeck, type DeckTrack } from '../lib/playerDeck'
import { useAudioSrc } from '../lib/useAudioSrc'
import { CopyablePath } from './CopyablePath'
import { Waveform } from './Waveform'
import { api } from '../lib/api/client'

// トラック 1 本分の <audio>。tar 内エントリは useAudioSrc が blob 化するため、
// blob 取得が終わる (src が非 null になる) までは何もマウントしない — サーバー
// 直リンクを src に使うと Range 非対応でシークが現在位置に巻き戻る不具合の対象に
// なるため (PreviewAudio と同じ対策)。
function DeckAudio({
  track,
  register,
  onDuration,
  onArrive,
}: {
  track: DeckTrack
  register: (id: string, el: HTMLAudioElement | null) => void
  onDuration: (id: string, durationSec: number) => void
  onArrive: (id: string, el: HTMLAudioElement) => void
}) {
  const { src } = useAudioSrc(track.connId, track.bucket, track.key, track.entryPath)
  const elRef = useRef<HTMLAudioElement | null>(null)
  // ref callback は識別子が安定していないと再レンダーのたびに detach(null) →
  // attach(el) され、その隙間で audioRefs から要素が消える。register を親が
  // useCallback で安定させ、ここも useCallback で包むことで、本当のマウント /
  // アンマウントでしか audioRefs を触らない。
  const setRef = useCallback((el: HTMLAudioElement | null) => {
    elRef.current = el
    register(track.id, el)
  }, [register, track.id])

  // onArrive は「このトラックに <audio> が初めて現れた」1 回だけ通知する。
  //
  // ref callback ではなく effect から呼ぶ。ref の attach は commit 中に走るため、
  // 同じコミットで再レンダーされた兄弟トラックの ref はまだ張り直されておらず、
  // onArrive が audioRefs 経由でマスターを探しても見つからないことがある
  // (見つからないと後着トラックが 0 秒から鳴り始める)。effect なら全ての ref が
  // 出揃った後に走る。arrivedRef で 1 回に絞るので毎コミット走っても害はない。
  const arrivedRef = useRef(false)
  useEffect(() => {
    const el = elRef.current
    if (!el || arrivedRef.current) return
    arrivedRef.current = true
    onArrive(track.id, el)
  })

  if (!src) return null
  return (
    <audio
      ref={setRef}
      src={src}
      preload="metadata"
      onLoadedMetadata={e => {
        const d = e.currentTarget.duration
        if (Number.isFinite(d)) onDuration(track.id, d)
      }}
    />
  )
}

// マルチチャンネル録音のチャンネル別ファイルを頭出しを揃えて同時再生する
// セクション。<audio> ベース + 1 秒ごとのドリフト補正 (サンプル精度ではない)。
// fixed の外枠は BottomDock が持つ (ピン留めセクションと単一コンテナに同居させる
// ため、ここでは fixed を張らない)。トラック 0 件では何も描画しない。
export function PlayerDeck() {
  const { tracks, removeTrack, clear } = usePlayerDeck()
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const [playing, setPlaying] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [masterTime, setMasterTime] = useState(0)
  const [soloId, setSoloId] = useState<string | null>(null)
  const [muted, setMuted] = useState<Set<string>>(new Set())
  const [peaksById, setPeaksById] = useState<Record<string, Array<[number, number]>>>({})
  // トラックごとの再生チャンネル。**キーの存在 = そのトラックのグラフ構築済み**という
  // 不変条件を持たせている (both に戻してもエントリは消さない — 一度 <audio> を
  // AudioContext へ繋いだら二度と戻せないので、グラフは壊さず張り替えるだけ)。
  const [channelById, setChannelById] = useState<Record<string, ChannelMode>>({})
  // mediaAnalyze が返すチャンネル数。L/R を出せるか (mono でないか) の判定にだけ使う。
  const [channelsById, setChannelsById] = useState<Record<string, number | null>>({})
  // L/R を使うトラックの Web Audio ノード群と、それらが共有する AudioContext。
  // 再生位置に関わらない命令的ハンドルなので state ではなく ref に置く。
  const graphsRef = useRef(new Map<string, TrackAudioGraph>())
  const ctxRef = useRef<AudioContext | null>(null)
  // DeckAudio の ref callback を安定させるため空 deps。毎レンダーで新しい関数を
  // 渡すと ref が detach/attach を繰り返し、その隙間で audioRefs から要素が消える。
  const registerAudio = useCallback((id: string, el: HTMLAudioElement | null) => {
    if (el) audioRefs.current.set(id, el)
    else audioRefs.current.delete(id)
  }, [])
  // トラックごとの再生時間。マスターシークバーの max はここから導出する
  // (audios() = ref 経由の読み出しなので render 中に直接呼ぶと react-hooks/refs
  // に引っかかる。onLoadedMetadata というイベントハンドラで拾って state 化する)。
  const [durations, setDurations] = useState<Record<string, number>>({})
  // <audio> がマウント済み (= src 解決済み) のトラック ID。tar 内エントリは
  // blob 取得が終わるまで <audio> が存在しないため、行の「取得中…」表示は
  // この集合の否定で導出する (単体ファイルはマウント直後に入る)。
  const [readyIds, setReadyIds] = useState<Set<string>>(new Set())

  const audios = useCallback(
    () => tracks.map(t => audioRefs.current.get(t.id)).filter((a): a is HTMLAudioElement => a != null),
    [tracks],
  )

  // maxDuration は下で render 用にも計算するが、interval effect からも参照するため
  // ref にミラーする (render 内の変数を effect が直接読むと stale 値を掴む)。
  const maxDurationRef = useRef(0)
  useEffect(() => {
    maxDurationRef.current = Math.max(0, ...tracks.map(t => durations[t.id] ?? 0))
  }, [tracks, durations])

  // マスター時刻 = 非終了トラックの currentTime の最大値。1 秒ごとにドリフト補正。
  // 先頭トラック基準だと最短トラックが終わった瞬間に時計が止まり、補正が長い
  // トラックをその終端へ巻き戻してしまう。max ベースなら短いトラックが終わっても
  // 長いトラックが最後まで進み、短いトラックの終端以降は無音 (0 パディング) になる。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      // track と audio をペアで保持する。audios() の filter(null 除外) で
      // インデックスがずれる (blob 取得中トラックは <audio> 未マウント) のを避け、
      // computeDriftAdjustments の index から track の長さを正しく引くため。
      const entries = tracks
        .map(t => ({ t, a: audioRefs.current.get(t.id) }))
        .filter((e): e is { t: typeof e.t; a: HTMLAudioElement } => e.a != null)
      if (entries.length === 0) return
      const secs = entries.map(e => (e.a.ended ? null : e.a.currentTime))
      const master = masterTimeOf(secs)
      if (master == null) {
        // 全トラック終了 → 停止し、頭出しに戻れる状態にする。
        setPlaying(false)
        setMasterTime(maxDurationRef.current)
        return
      }
      setMasterTime(master)
      for (const adj of computeDriftAdjustments(master, secs)) {
        const e = entries[adj.index]
        const dur = durations[e.t.id] ?? Infinity
        // 自分の長さを超える位置へは飛ばさない (終端で自然に無音 = 0 パディング)。
        if (adj.to < dur) e.a.currentTime = adj.to
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, tracks, durations])

  // ソロ対象が削除済みなら「ソロなし」として扱う (削除ハンドラの setSoloId(null)
  // と二重の防御)。存在しない ID がソロ扱いのまま残ると全トラックが無音になり、
  // どの S ボタンもアクティブ表示にならず原因も見えない (幽霊ソロ)。ミュート計算と
  // S ボタンの押下表示 (反転チップ / aria-pressed) は必ずこちらを使う。
  const effectiveSoloId =
    soloId != null && tracks.some(t => t.id === soloId) ? soloId : null

  // そのトラックが今ミュートされるべきか (ソロが立っていればソロ以外が全部ミュート)。
  const isMuted = useCallback(
    (id: string) => (effectiveSoloId != null ? id !== effectiveSoloId : muted.has(id)),
    [effectiveSoloId, muted],
  )

  // ミュート / ソロを反映。setState は呼ばない (DOM プロパティ / gain への直接代入
  // のみ) ので react-hooks/set-state-in-effect の対象にはならない。
  //
  // グラフを持つトラックは gain が唯一のミュート源。<audio>.muted が
  // MediaElementAudioSourceNode 経由の出力に効くかはブラウザ実装依存なので、
  // L/R に触れていない大多数のトラックだけが従来どおり muted を使う。
  useEffect(() => {
    for (const t of tracks) {
      const a = audioRefs.current.get(t.id)
      if (!a) continue
      const g = graphsRef.current.get(t.id)
      if (g) g.setMuted(isMuted(t.id))
      else a.muted = isMuted(t.id)
    }
  }, [tracks, isMuted])

  // 各トラックの波形 (キャッシュ済みが多い想定)。失敗しても波形なしで続行する。
  // 同じレスポンスの meta.channels も拾う — L/R ボタンの有効判定に使うが、
  // そのためだけの追加リクエストは不要。
  //
  // 解析に失敗したときも channelsById に null を入れる。キーの有無が「チャンネル数を
  // 調べ終えたか」を表すので、入れないと L/R が「取得中」のまま永久に無効になる。
  useEffect(() => {
    for (const t of tracks) {
      if (peaksById[t.id]) continue
      api.mediaAnalyze(t.connId, t.bucket, t.key, { entryPath: t.entryPath })
        .then(r => {
          setPeaksById(cur => ({ ...cur, [t.id]: r.peaks }))
          setChannelsById(cur => ({ ...cur, [t.id]: r.meta?.channels ?? null }))
        })
        .catch(() => {
          setChannelsById(cur => (t.id in cur ? cur : { ...cur, [t.id]: null }))
        })
    }
  }, [tracks, peaksById])

  // 外から removeTrack された (この component の ✕ を経由しない) トラックの
  // ノードを掃除する。durations に幽霊が残りうるのと同じ穴を塞ぐ防御。
  //
  // トラックが 0 件になったら ctx も畳む。✕ で 1 本ずつ消した場合、ピンが 1 件でも
  // 残っていると BottomDock は PlayerDeck を描画し続ける (tracks 0 件の `return null`
  // はフック実行後なのでアンマウントされない) ため、ここで閉じないと使われない
  // AudioContext がオーディオスレッドごと居座る。
  useEffect(() => {
    const ids = new Set(tracks.map(t => t.id))
    for (const [id, g] of graphsRef.current) {
      if (ids.has(id)) continue
      g.dispose()
      graphsRef.current.delete(id)
    }
    if (tracks.length === 0 && ctxRef.current) {
      void ctxRef.current.close().catch(() => { /* 二重 close は無視 */ })
      ctxRef.current = null
    }
  }, [tracks])

  // 本当の unmount でのみ走る。
  useEffect(() => {
    const graphs = graphsRef.current
    const ctxHolder = ctxRef
    return () => {
      for (const g of graphs.values()) g.dispose()
      graphs.clear()
      void ctxHolder.current?.close().catch(() => { /* 二重 close は無視 */ })
      ctxHolder.current = null
    }
  }, [])

  if (tracks.length === 0) return null

  // AudioContext のコンストラクタ。render 内で解決する (テストの stubGlobal を
  // 取りこぼさないため)。未対応ブラウザでは L/R ボタン自体を出さない。
  const AudioCtx = getAudioContextCtor()

  const disposeGraph = (id: string): void => {
    const g = graphsRef.current.get(id)
    if (!g) return
    g.dispose()
    graphsRef.current.delete(id)
  }

  // L / R ボタン。押されたトラックのグラフをここで初めて作る。
  //
  // createMediaElementSource() は 1 要素 1 回きりで、呼んだ瞬間からその <audio> は
  // AudioContext 経由でしか鳴らなくなる。deck のマウント時や初回 ▶ でまとめて作ると、
  // L/R を使わないユーザーまで巻き込み、autoplay policy で ctx が suspended のままだと
  // 「両チャンネルすら無音」という退行になる。ユーザーが L/R を押した瞬間 (= gesture)
  // にそのトラックだけ作れば、触らないトラックは今までどおりネイティブ出力で鳴る。
  const toggleChannel = (t: DeckTrack, pressed: ChannelSide): void => {
    const el = audioRefs.current.get(t.id)
    if (!el || !AudioCtx) return
    const mode = nextChannelMode(channelById[t.id] ?? 'both', pressed)
    const existing = graphsRef.current.get(t.id)
    if (existing) {
      existing.setChannel(mode)
    } else {
      const ctx = (ctxRef.current ??= new AudioCtx())
      void ctx.resume().catch(() => { /* 既に running / close 済みなら無視 */ })
      const g = createTrackAudioGraph(ctx, el, mode)
      graphsRef.current.set(t.id, g)
      // ミュート状態を要素から gain へ引き継ぎ、要素側は必ず解除する。
      // 両方に効かせたままだと、後で unmute しても要素が muted のまま残って無音になる。
      g.setMuted(el.muted)
      el.muted = false
    }
    setChannelById(cur => ({ ...cur, [t.id]: mode }))
  }

  const playAll = (): void => {
    // 全トラック終了状態から ▶ を押したら頭から再生し直す。
    if (maxDuration > 0 && masterTime >= maxDuration) {
      for (const a of audios()) a.currentTime = 0
      setMasterTime(0)
    }
    // タブ復帰などで suspended に戻った ctx を起こす。L/R 未使用なら ctx は
    // 無い (null) ので no-op — 既定の再生経路には一切触らない。
    void ctxRef.current?.resume().catch(() => { /* 既に running なら無視 */ })
    for (const a of audios()) void a.play()
    setPlaying(true)
  }
  const pauseAll = (): void => {
    for (const a of audios()) a.pause()
    setPlaying(false)
  }
  const stopAll = (): void => {
    for (const a of audios()) {
      a.pause()
      a.currentTime = 0
    }
    setPlaying(false)
    setMasterTime(0)
  }
  const seekAll = (sec: number): void => {
    for (const t of tracks) {
      const a = audioRefs.current.get(t.id)
      if (!a) continue
      const dur = durations[t.id] ?? Infinity
      // 自分の長さ以内ならその位置へ。超える場合は終端 (無音 = 0 パディング)。
      a.currentTime = Math.min(sec, dur)
      if (playing && sec < dur) void a.play()
    }
    setMasterTime(sec)
  }
  // <audio> が後から現れたトラックへの追従 (DeckAudio が 1 マウント 1 回だけ呼ぶ)。
  // blob 取得中のトラックは playAll 時点で <audio> が存在せず play 対象から漏れる
  // ため、再生中ならマスター時刻へシークして再生を開始する — これが無いと
  // 「▶ は押せたのにそのトラックだけ永久に無音」のまま取り残される。
  const onTrackArrive = (id: string, el: HTMLAudioElement): void => {
    setReadyIds(cur => {
      if (cur.has(id)) return cur
      const next = new Set(cur)
      next.add(id)
      return next
    })
    // 現在のミュート / ソロを後着トラックにも適用する。ミュート反映 effect の依存は
    // [tracks, isMuted] で、「<audio> が生えた」ことは含まれない。ここで明示しないと
    // ソロ中に blob 解決したトラックが muted=false のまま鳴ってしまう。
    // (グラフはまだ無い — 構築には <audio> が要るので、必ず要素側の muted で足りる)
    el.muted = isMuted(id)
    if (!playing) return
    // マスターは必ず自分以外から選ぶ。後着が tracks の先頭スロットだと
    // audios()[0] は自分自身になり、シークがスキップされて 0 秒スタート →
    // ドリフト補正 (マスター = 先頭 = 0 秒) が他トラックまで 0 秒へ巻き戻す。
    const master = audios().find(a => a !== el)
    if (master) el.currentTime = master.currentTime
    void el.play()
  }
  // durations には削除済みトラックの値が残りうる (外部からの removeTrack は
  // この component の削除ハンドラを通らない) ため、現在の tracks に限定して導出。
  const maxDuration = Math.max(0, ...tracks.map(t => durations[t.id] ?? 0))
  const fmt = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  // S(ソロ)/M(ミュート) のアクティブ状態は反転チップ (黒背景 + 紙色文字) で
  // 明示する — font-bold / opacity だけでは押されているか視認しにくい。
  const toggleBtnStyle = (active: boolean): CSSProperties | undefined =>
    active
      ? { background: 'var(--color-ink-12)', color: 'var(--paper)', borderRadius: 2 }
      : undefined

  return (
    <section>
      <div className="flex items-center gap-3">
        <button type="button" className="ghost text-[11px]" onClick={() => setCollapsed(c => !c)}>
          {collapsed ? '▲' : '▼'} 同期プレイヤー ({tracks.length})
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className="ghost text-[11px]"
          onClick={() => {
            stopAll()
            clear()
            setSoloId(null)
            setMuted(new Set())
            setDurations({})
            setReadyIds(new Set())
            setChannelById({})
            setChannelsById({})
            // peaksById は「解析済みか」の番人も兼ねている。channelsById だけ捨てて
            // ここを残すと、同じトラックを再追加しても解析 effect が skip され、
            // チャンネル数が永久に不明のまま L/R が無効になる。
            setPeaksById({})
            for (const g of graphsRef.current.values()) g.dispose()
            graphsRef.current.clear()
            // ブラウザは同時に開ける AudioContext 数に上限がある。全トラックが
            // 消えるここで閉じる。close 済みの ctx ではノードを作れないので null に
            // 戻し、次に L/R が押されたら新しい ctx を作り直させる。
            void ctxRef.current?.close().catch(() => { /* 二重 close は無視 */ })
            ctxRef.current = null
          }}
        >
          クリア
        </button>
      </div>
      {/* <audio> は折りたたみ状態に関わらず常にマウントする。
          {!collapsed && ...} の中に置くとたたんだ瞬間にアンマウントされて
          再生が止まり、再展開で currentTime=0 の新要素になってしまう
          (playing state だけ true のまま残る UI 矛盾も起きる)。
          もともと不可視 (controls なし) なので置き場所は UI に影響しない。 */}
      {tracks.map(t => (
        <DeckAudio
          key={t.id}
          track={t}
          register={registerAudio}
          onDuration={(id, d) => setDurations(cur => ({ ...cur, [id]: d }))}
          onArrive={onTrackArrive}
        />
      ))}
      {!collapsed && (
        <>
          <ul className="m-0 max-h-48 list-none overflow-y-auto p-0">
            {tracks.map(t => {
              // 表示は basename に揃える。t.label は tar エントリだとフルエントリパス
              // (audio/mic_01.wav)、単体ファイルだと basename と意味が揃っておらず、
              // 幅の狭い枠で truncate すると肝心のファイル名から切れてしまう。
              // ホバーとコピーには「アーカイブ名 › エントリ名」のフルパスを載せる。
              const fullPath = fullEntryLabel(t.key, t.entryPath)
              const mode = channelById[t.id] ?? 'both'
              // <audio> が生えるまではグラフを作れない (tar は blob 取得待ち)。
              // mono は splitter の output 1 が無音なので R を押させない。
              //
              // channelsById にキーが無い間は「まだ調べていない」= 押させない。
              // 解析が返る前に mono で R を押されると無音になり、原因が見えないため
              // (解析失敗時も null が入るので、ここで永久に無効化されることはない)。
              const ready = readyIds.has(t.id)
              const channelsKnown = t.id in channelsById
              const splittable = canSplitChannels(channelsById[t.id])
              const lrDisabled = !ready || !channelsKnown || !splittable
              const lrTitle = !ready ? '取得中'
                : !channelsKnown ? 'チャンネル数を調べています'
                : !splittable ? 'モノラルのため分割できません'
                : '選んだチャンネルを左右両方から鳴らす'
              return (
              <li key={t.id} className="flex items-center gap-2 py-1" style={{ borderTop: '1px solid var(--rule)' }}>
                <CopyablePath
                  text={basename(t.label)}
                  fullPath={fullPath}
                  className="w-56 text-[12px] text-ink-11"
                />
                {/* tar 内エントリは blob 取得が終わるまで再生できない。無表示だと
                    ▶ を押しても鳴らない理由が見えないので、取得中を明示する。 */}
                {t.entryPath != null && !readyIds.has(t.id) && (
                  <span className="shrink-0 text-[11px] text-ink-7">取得中…</span>
                )}
                <div className="min-w-0 flex-1">
                  <Waveform
                    peaks={peaksById[t.id] ?? []}
                    progress={maxDuration > 0 ? masterTime / maxDuration : 0}
                    durationRatio={maxDuration > 0 ? (durations[t.id] ?? 0) / maxDuration : 1}
                    onSeek={maxDuration > 0 ? ratio => seekAll(ratio * maxDuration) : undefined}
                    height={28}
                  />
                </div>
                {/* L / R: 既定は両チャンネル (どちらも非押下)。Web Audio 非対応の
                    ブラウザでは出さない — 押しても何も起きないボタンは害しかない。 */}
                {AudioCtx && (
                  <>
                    <button
                      type="button"
                      className="ghost text-[11px]"
                      style={toggleBtnStyle(mode === 'left')}
                      aria-pressed={mode === 'left'}
                      aria-label="左チャンネル"
                      title={lrTitle}
                      disabled={lrDisabled}
                      onClick={() => toggleChannel(t, 'left')}
                    >L</button>
                    <button
                      type="button"
                      className="ghost text-[11px]"
                      style={toggleBtnStyle(mode === 'right')}
                      aria-pressed={mode === 'right'}
                      aria-label="右チャンネル"
                      title={lrTitle}
                      disabled={lrDisabled}
                      onClick={() => toggleChannel(t, 'right')}
                    >R</button>
                  </>
                )}
                <button
                  type="button"
                  className="ghost text-[11px]"
                  style={toggleBtnStyle(muted.has(t.id))}
                  aria-pressed={muted.has(t.id)}
                  aria-label="ミュート"
                  onClick={() => setMuted(cur => {
                    const next = new Set(cur)
                    if (next.has(t.id)) next.delete(t.id)
                    else next.add(t.id)
                    return next
                  })}
                >M</button>
                <button
                  type="button"
                  className="ghost text-[11px]"
                  style={toggleBtnStyle(effectiveSoloId === t.id)}
                  aria-pressed={effectiveSoloId === t.id}
                  aria-label="ソロ"
                  onClick={() => setSoloId(cur => (cur === t.id ? null : t.id))}
                >S</button>
                <button
                  type="button"
                  className="ghost text-[11px]"
                  aria-label="削除"
                  onClick={() => {
                    removeTrack(t.id)
                    // 削除トラックに紐づく状態を漏れなく剪定する。soloId は
                    // effectiveSoloId の導出でも守られるが、明示的に消して
                    // 「消したトラックの ID が state に残る」余地をなくす。
                    // Web Audio ノードは reconcile effect でも拾えるが、ここでも
                    // 即座に畳んで <audio> より長生きさせない。
                    disposeGraph(t.id)
                    setChannelById(cur => {
                      if (!(t.id in cur)) return cur
                      const next = { ...cur }
                      delete next[t.id]
                      return next
                    })
                    setChannelsById(cur => {
                      if (!(t.id in cur)) return cur
                      const next = { ...cur }
                      delete next[t.id]
                      return next
                    })
                    // peaksById は解析 effect の「解析済みか」の番人でもある。残すと
                    // 再追加時に skip され、チャンネル数が不明のまま L/R が無効になる。
                    setPeaksById(cur => {
                      if (!(t.id in cur)) return cur
                      const next = { ...cur }
                      delete next[t.id]
                      return next
                    })
                    setSoloId(cur => (cur === t.id ? null : cur))
                    setMuted(cur => {
                      if (!cur.has(t.id)) return cur
                      const next = new Set(cur)
                      next.delete(t.id)
                      return next
                    })
                    setDurations(cur => {
                      if (!(t.id in cur)) return cur
                      const next = { ...cur }
                      delete next[t.id]
                      return next
                    })
                    setReadyIds(cur => {
                      if (!cur.has(t.id)) return cur
                      const next = new Set(cur)
                      next.delete(t.id)
                      return next
                    })
                  }}
                >✕</button>
              </li>
              )
            })}
          </ul>
          <div className="flex items-center gap-3 pt-1" style={{ borderTop: '1px solid var(--rule)' }}>
            {playing ? (
              <button type="button" className="ghost" aria-label="一時停止" onClick={pauseAll}>⏸</button>
            ) : (
              <button type="button" className="ghost" aria-label="一括再生" onClick={playAll}>▶</button>
            )}
            <button type="button" className="ghost" aria-label="停止" onClick={stopAll}>■</button>
            <span className="text-[11px] tabular-nums text-ink-7">{fmt(masterTime)} / {fmt(maxDuration)}</span>
            <input
              type="range"
              className="flex-1"
              min={0}
              max={maxDuration || 0}
              step={0.1}
              value={masterTime}
              aria-label="マスターシーク"
              onChange={e => seekAll(Number(e.target.value))}
            />
          </div>
        </>
      )}
    </section>
  )
}
