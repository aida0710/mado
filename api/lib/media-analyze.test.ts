import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { analyzeAudio, MediaAnalyzeError } from './media-analyze.js'

const FIXTURE = new URL('./test-fixtures/tone.wav', import.meta.url).pathname

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
