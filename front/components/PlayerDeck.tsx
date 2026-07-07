import { useCallback, useEffect, useRef, useState } from 'react'
import { computeDriftAdjustments } from '../lib/driftSync'
import { usePlayerDeck } from '../lib/playerDeck'
import { Waveform } from './Waveform'
import { api } from '../lib/api/client'

// マルチチャンネル録音のチャンネル別ファイルを頭出しを揃えて同時再生する
// 画面下部ドック。<audio> ベース + 1 秒ごとのドリフト補正 (サンプル精度ではない)。
export function PlayerDeck() {
  const { tracks, removeTrack, clear } = usePlayerDeck()
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const [playing, setPlaying] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [masterTime, setMasterTime] = useState(0)
  const [soloId, setSoloId] = useState<string | null>(null)
  const [muted, setMuted] = useState<Set<string>>(new Set())
  const [peaksById, setPeaksById] = useState<Record<string, Array<[number, number]>>>({})
  // トラックごとの再生時間。マスターシークバーの max はここから導出する
  // (audios() = ref 経由の読み出しなので render 中に直接呼ぶと react-hooks/refs
  // に引っかかる。onLoadedMetadata というイベントハンドラで拾って state 化する)。
  const [durations, setDurations] = useState<Record<string, number>>({})

  const audios = useCallback(
    () => tracks.map(t => audioRefs.current.get(t.id)).filter((a): a is HTMLAudioElement => a != null),
    [tracks],
  )

  // マスター時刻 = 最初のトラックの currentTime。1 秒ごとにドリフト補正。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const list = audios()
      const master = list[0]
      if (!master) return
      setMasterTime(master.currentTime)
      const secs = list.map(a => (a.ended ? null : a.currentTime))
      for (const adj of computeDriftAdjustments(master.currentTime, secs)) {
        list[adj.index].currentTime = adj.to
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, audios])

  // ミュート / ソロを <audio> に反映。setState は呼ばない (DOM プロパティへの
  // 直接代入のみ) ので react-hooks/set-state-in-effect の対象にはならない。
  useEffect(() => {
    for (const t of tracks) {
      const a = audioRefs.current.get(t.id)
      if (!a) continue
      a.muted = soloId != null ? t.id !== soloId : muted.has(t.id)
    }
  }, [tracks, soloId, muted])

  // 各トラックの波形 (キャッシュ済みが多い想定)。失敗は静かに無視。
  useEffect(() => {
    for (const t of tracks) {
      if (peaksById[t.id]) continue
      api.mediaAnalyze(t.connId, t.bucket, t.key, { entryPath: t.entryPath })
        .then(r => setPeaksById(cur => ({ ...cur, [t.id]: r.peaks })))
        .catch(() => { /* デッキでは波形なしで続行 */ })
    }
  }, [tracks, peaksById])

  if (tracks.length === 0) return null

  const playAll = (): void => {
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
    for (const a of audios()) a.currentTime = sec
    setMasterTime(sec)
  }
  const maxDuration = Math.max(0, ...Object.values(durations))
  const fmt = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t"
      style={{ borderColor: 'var(--color-rule-strong)', background: 'var(--paper)' }}
    >
      <div className="mx-auto max-w-[1180px] px-4 py-2 sm:px-6">
        <div className="flex items-center gap-3">
          <button type="button" className="ghost text-[11px]" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? '▲' : '▼'} 同期プレイヤー ({tracks.length})
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="ghost text-[11px]"
            onClick={() => { stopAll(); clear(); setDurations({}) }}
          >
            クリア
          </button>
        </div>
        {!collapsed && (
          <>
            <ul className="m-0 max-h-48 list-none overflow-y-auto p-0">
              {tracks.map(t => (
                <li key={t.id} className="flex items-center gap-2 py-1" style={{ borderTop: '1px solid var(--rule)' }}>
                  <span className="w-40 truncate text-[12px] text-ink-11" title={t.label}>{t.label}</span>
                  <div className="min-w-0 flex-1">
                    <Waveform
                      peaks={peaksById[t.id] ?? []}
                      progress={maxDuration > 0 ? masterTime / maxDuration : 0}
                      height={28}
                    />
                  </div>
                  <audio
                    ref={el => {
                      if (el) audioRefs.current.set(t.id, el)
                      else audioRefs.current.delete(t.id)
                    }}
                    src={t.src}
                    preload="metadata"
                    onLoadedMetadata={e => {
                      const d = e.currentTarget.duration
                      if (Number.isFinite(d)) setDurations(cur => ({ ...cur, [t.id]: d }))
                    }}
                  />
                  <button
                    type="button"
                    className={`ghost text-[11px] ${muted.has(t.id) ? 'opacity-40' : ''}`}
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
                    className={`ghost text-[11px] ${soloId === t.id ? 'font-bold' : ''}`}
                    aria-label="ソロ"
                    onClick={() => setSoloId(cur => (cur === t.id ? null : t.id))}
                  >S</button>
                  <button
                    type="button"
                    className="ghost text-[11px]"
                    aria-label="削除"
                    onClick={() => {
                      removeTrack(t.id)
                      setDurations(cur => {
                        if (!(t.id in cur)) return cur
                        const next = { ...cur }
                        delete next[t.id]
                        return next
                      })
                    }}
                  >✕</button>
                </li>
              ))}
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
      </div>
    </div>
  )
}
