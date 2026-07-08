import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { analyzeAudio, MediaAnalyzeError, resolveBitRate } from './media-analyze.js'

const FIXTURE = new URL('./test-fixtures/tone.wav', import.meta.url).pathname
// tone.wav を libmp3lame 32kbps でエンコードしたもの。ffprobe が
// bits_per_sample: 0 (欠落ではなく数値 0) を返す非可逆コーデックの代表。
const FIXTURE_MP3 = new URL('./test-fixtures/tone.mp3', import.meta.url).pathname

// ffmpeg が無い環境ではスキップ (CI は media-worker コンテナ内で実行する前提)
const hasFfmpeg = await (async () => {
  const { execFile } = await import('node:child_process')
  return new Promise<boolean>(resolve => {
    execFile('ffmpeg', ['-version'], err => resolve(!err))
  })
})()

describe.skipIf(!hasFfmpeg)('analyzeAudio', () => {
  const opts = () => ({
    openStream: async () => createReadStream(FIXTURE) as NodeJS.ReadableStream,
    probeHead: async () => (await readFile(FIXTURE)).subarray(0, 256 * 1024) as Buffer,
    timeoutMs: 30_000,
    maxSpectrogramWidth: 4096,
  })

  it('1 秒の wav から duration / sampleRate / peaks / spectrogram を得る', async () => {
    const r = await analyzeAudio(opts())
    expect(r.durationSec).toBeGreaterThan(0.9)
    expect(r.durationSec).toBeLessThan(1.1)
    expect(r.sampleRate).toBe(16000)
    expect(r.peaks.length).toBeGreaterThan(0)
    expect(r.peaks.length).toBeLessThanOrEqual(2000)
    // 440Hz サイン波: ピークは ±1 近辺
    expect(Math.max(...r.peaks.map(p => p[1]))).toBeGreaterThan(0.5)
    // PNG マジックナンバー
    expect(r.spectrogramPng?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  }, 60_000)

  it('meta にコーデック/チャンネル/ビット深度/サイズ/音量が乗る (fixture: pcm_s16le/mono/16000Hz)', async () => {
    const size = (await readFile(FIXTURE)).length
    const r = await analyzeAudio({ ...opts(), getSizeBytes: () => size })
    expect(r.meta.codec).toBe('pcm_s16le')
    expect(r.meta.container).toBe('wav')
    expect(r.meta.channels).toBe(1)
    expect(r.meta.bitsPerSample).toBe(16)
    expect(r.meta.bitRate).toBeGreaterThan(0)
    expect(r.meta.sizeBytes).toBe(size)
    // ほぼフルスケールのサイン波: peak は 0 dBFS 付近、RMS はそれより低い
    expect(r.meta.peakDb).not.toBeNull()
    expect(r.meta.peakDb as number).toBeGreaterThan(-3)
    expect(r.meta.rmsDb).not.toBeNull()
    expect(r.meta.rmsDb as number).toBeLessThan(r.meta.peakDb as number)
  }, 60_000)

  it('getSizeBytes 未指定なら meta.sizeBytes は null', async () => {
    const r = await analyzeAudio(opts())
    expect(r.meta.sizeBytes).toBeNull()
  }, 60_000)

  it('mp3 (bits_per_sample: 0) は bitsPerSample null になる', async () => {
    const r = await analyzeAudio({
      openStream: async () => createReadStream(FIXTURE_MP3) as NodeJS.ReadableStream,
      probeHead: async () => (await readFile(FIXTURE_MP3)).subarray(0, 256 * 1024) as Buffer,
      timeoutMs: 30_000,
      maxSpectrogramWidth: 4096,
    })
    expect(r.meta.codec).toBe('mp3')
    // ffprobe は mp3 で bits_per_sample: 0 (数値 0、欠落ではない) を返す —
    // 0 を素通しせず「無し」= null として扱う。
    expect(r.meta.bitsPerSample).toBeNull()
    expect(r.meta.bitRate).toBe(32000)
  }, 60_000)

  it('非音声データは MediaAnalyzeError', async () => {
    const junk = Buffer.from('not audio at all')
    await expect(analyzeAudio({
      openStream: async () => Readable.from(junk) as NodeJS.ReadableStream,
      probeHead: async () => junk,
      timeoutMs: 30_000,
      maxSpectrogramWidth: 4096,
    })).rejects.toBeInstanceOf(MediaAnalyzeError)
  }, 60_000)

  it('事前に abort 済みの signal を渡すと即座に MediaAnalyzeError で reject する', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    await expect(analyzeAudio({ ...opts(), signal: ctrl.signal }))
      .rejects.toBeInstanceOf(MediaAnalyzeError)
    expect(Date.now() - start).toBeLessThan(500)
  }, 60_000)

  it('入力ストリームが途中で error を出すと MediaAnalyzeError で reject する', async () => {
    const err = await analyzeAudio({
      openStream: async () => new Readable({
        read() {
          this.push(Buffer.alloc(1024))
          this.destroy(new Error('upstream failed'))
        },
      }) as NodeJS.ReadableStream,
      probeHead: async () => (await readFile(FIXTURE)).subarray(0, 256 * 1024) as Buffer,
      timeoutMs: 30_000,
      maxSpectrogramWidth: 4096,
    }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(MediaAnalyzeError)
    expect((err as MediaAnalyzeError).message).toMatch(/input stream/)
    expect((err as MediaAnalyzeError).stderrSummary).toContain('upstream failed')
  }, 60_000)
})

// ffmpeg 有無に関わらず動く純ロジック。
describe('resolveBitRate', () => {
  it('stream の bit_rate を最優先する', () => {
    expect(resolveBitRate(128_000, 130_000, 999_999, 10)).toBe(128_000)
  })

  it('stream が無ければ format の bit_rate', () => {
    expect(resolveBitRate(null, 130_000, 999_999, 10)).toBe(130_000)
  })

  it('どちらも無ければ sizeBytes*8/durationSec の計算値', () => {
    expect(resolveBitRate(null, null, 125_000, 8)).toBe(125_000)
  })

  it('sizeBytes / durationSec も無ければ null', () => {
    expect(resolveBitRate(null, null, null, 8)).toBeNull()
    expect(resolveBitRate(null, null, 100, 0)).toBeNull()
  })
})
