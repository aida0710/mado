import { describe, expect, it } from 'vitest'
import { type AudioMeta, formatAudioInfoLines } from './audioInfo'

const fullMeta: AudioMeta = {
  codec: 'flac',
  container: 'flac',
  channels: 2,
  bitsPerSample: 24,
  bitRate: 1411000,
  sizeBytes: 2097152,
  peakDb: -0.3,
  rmsDb: -18.2,
}

describe('formatAudioInfoLines', () => {
  it('meta が null なら情報行なし', () => {
    expect(formatAudioInfoLines(null, 12.345, 48000)).toEqual([])
  })

  it('codec と container が同一なら片方だけ表示 (FLAC · FLAC を避ける)', () => {
    const lines = formatAudioInfoLines(fullMeta, 12.345, 48000)
    expect(lines).toEqual([
      'FLAC · stereo · 48 kHz · 24 bit',
      '1411 kbps · 0:12.345 · 2.0 MB',
      'peak -0.3 dBFS · RMS -18.2 dB',
    ])
  })

  it('codec と container が異なれば両方表示し、container は先頭トークンのみ大文字化', () => {
    const meta: AudioMeta = {
      ...fullMeta,
      codec: 'aac',
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
    }
    const lines = formatAudioInfoLines(meta, 12.345, 48000)
    expect(lines[0]).toBe('AAC · MOV · stereo · 48 kHz · 24 bit')
  })

  it('channels: 1 は mono, 2 は stereo, それ以外は N ch', () => {
    expect(formatAudioInfoLines({ ...fullMeta, channels: 1 }, 1, 48000)[0]).toContain('mono')
    expect(formatAudioInfoLines({ ...fullMeta, channels: 2 }, 1, 48000)[0]).toContain('stereo')
    expect(formatAudioInfoLines({ ...fullMeta, channels: 6 }, 1, 48000)[0]).toContain('6 ch')
  })

  it('bitsPerSample が null の項目は詰めて省略される (mp3 等)', () => {
    const meta: AudioMeta = { ...fullMeta, codec: 'mp3', container: 'mp3', bitsPerSample: null }
    const lines = formatAudioInfoLines(meta, 12.345, 44100)
    expect(lines[0]).toBe('MP3 · stereo · 44.1 kHz')
  })

  it('sampleRate が null なら kHz を省略', () => {
    const lines = formatAudioInfoLines(fullMeta, 12.345, null)
    expect(lines[0]).toBe('FLAC · stereo · 24 bit')
  })

  it('無音ファイルは peakDb/rmsDb が null になり音量行ごと省略', () => {
    const meta: AudioMeta = { ...fullMeta, peakDb: null, rmsDb: null }
    const lines = formatAudioInfoLines(meta, 12.345, 48000)
    expect(lines).toHaveLength(2)
    expect(lines.some(l => l.includes('peak') || l.includes('RMS'))).toBe(false)
  })

  it('sizeBytes/bitRate/durationSec が全て null なら 2 行目も省略される', () => {
    const meta: AudioMeta = { ...fullMeta, bitRate: null, sizeBytes: null }
    const lines = formatAudioInfoLines(meta, null, 48000)
    expect(lines).toEqual([
      'FLAC · stereo · 48 kHz · 24 bit',
      'peak -0.3 dBFS · RMS -18.2 dB',
    ])
  })

  it('時間表記: 1 時間未満は m:ss.mmm', () => {
    const meta: AudioMeta = { ...fullMeta, bitRate: null, sizeBytes: null, peakDb: null, rmsDb: null }
    expect(formatAudioInfoLines(meta, 0, 48000)[1]).toBe('0:00.000')
    expect(formatAudioInfoLines(meta, 12.345, 48000)[1]).toBe('0:12.345')
  })

  it('時間表記の境界: 3600 秒ちょうどで h:mm:ss (ミリ秒なし) に切り替わる', () => {
    const meta: AudioMeta = { ...fullMeta, bitRate: null, sizeBytes: null, peakDb: null, rmsDb: null }
    expect(formatAudioInfoLines(meta, 3599.999, 48000)[1]).toBe('59:59.999')
    expect(formatAudioInfoLines(meta, 3600, 48000)[1]).toBe('1:00:00')
    expect(formatAudioInfoLines(meta, 3661, 48000)[1]).toBe('1:01:01')
  })

  it('sizeBytes は既存 fmtSize を再利用したフォーマットになる', () => {
    const lines = formatAudioInfoLines(fullMeta, 12.345, 48000)
    expect(lines[1]).toContain('2.0 MB')
  })
})
