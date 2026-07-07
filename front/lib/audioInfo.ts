// 音声プレビューの情報行フォーマッター。API から届く meta (null 許容フィールド群) を
// 表示用の最大 3 行に整形する純関数。null 項目は詰めて省略し、行全体が空になる場合は
// 行ごと省略する。詳細は docs/superpowers/specs/2026-07-08-audio-info-display-design.md 参照。
import { fmtSize } from './format'

export interface AudioMeta {
  codec: string | null
  container: string | null
  channels: number | null
  bitsPerSample: number | null
  bitRate: number | null
  sizeBytes: number | null
  peakDb: number | null
  rmsDb: number | null
}

// container は ffprobe format_name の生値で、m4a 等では "mov,mp4,m4a,3gp,3g2,mj2" の
// ようなカンマ区切りになる。先頭トークンのみ使う。codec と同一なら片方だけ表示する
// (例: FLAC ファイルは codec="flac" / container="flac" → "FLAC" のみ)。
function fmtCodecContainer(codec: string | null, container: string | null): string | null {
  const codecDisp = codec ? codec.toUpperCase() : null
  const containerDisp = container ? (container.split(',')[0] ?? '').toUpperCase() : null
  if (codecDisp && containerDisp) {
    return codecDisp === containerDisp ? codecDisp : `${codecDisp} · ${containerDisp}`
  }
  return codecDisp ?? containerDisp
}

function fmtChannels(channels: number | null): string | null {
  if (channels == null) return null
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels} ch`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// m:ss.mmm。1 時間以上は h:mm:ss (ミリ秒なし)。totalMs から直接算出することで
// 3599.9995 のような境界値でも h への繰り上がりと表示が一致する。
function fmtDuration(sec: number): string {
  const totalMs = Math.round(sec * 1000)
  const h = Math.floor(totalMs / 3_600_000)
  const remAfterH = totalMs - h * 3_600_000
  const m = Math.floor(remAfterH / 60_000)
  const remAfterM = remAfterH - m * 60_000
  const s = Math.floor(remAfterM / 1000)
  const ms = remAfterM - s * 1000
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}.${String(ms).padStart(3, '0')}`
}

export function formatAudioInfoLines(
  meta: AudioMeta | null,
  durationSec: number | null,
  sampleRate: number | null,
): string[] {
  if (!meta) return []

  const line1 = [
    fmtCodecContainer(meta.codec, meta.container),
    fmtChannels(meta.channels),
    sampleRate != null ? `${sampleRate / 1000} kHz` : null,
    meta.bitsPerSample != null ? `${meta.bitsPerSample} bit` : null,
  ].filter((v): v is string => v != null)

  const line2 = [
    meta.bitRate != null ? `${Math.round(meta.bitRate / 1000)} kbps` : null,
    durationSec != null ? fmtDuration(durationSec) : null,
    meta.sizeBytes != null ? fmtSize(meta.sizeBytes) : null,
  ].filter((v): v is string => v != null)

  const line3 = [
    meta.peakDb != null ? `peak ${meta.peakDb.toFixed(1)} dBFS` : null,
    meta.rmsDb != null ? `RMS ${meta.rmsDb.toFixed(1)} dB` : null,
  ].filter((v): v is string => v != null)

  return [line1, line2, line3]
    .filter(line => line.length > 0)
    .map(line => line.join(' · '))
}
