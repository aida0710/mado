import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('media client', () => {
  it('mediaAnalyze: URL / signal / zod parse', async () => {
    const meta = {
      codec: 'flac', container: 'flac', channels: 2, bitsPerSample: 24,
      bitRate: 1411000, sizeBytes: 2097152, peakDb: -0.3, rmsDb: -18.2,
    }
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 2, sampleRate: 16000, hasSpectrogram: true, meta,
    }))
    const ctl = new AbortController()
    const r = await api.mediaAnalyze('c 1', 'b', 'dir/a.wav', { signal: ctl.signal })
    expect(r.cacheKey).toBe('ck')
    expect(r.meta).toEqual(meta)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c%201/media/analyze?bucket=b&key=dir%2Fa.wav')
    expect((init as RequestInit).signal).toBe(ctl.signal)
  })

  it('mediaAnalyze: meta が null でもパースできる (旧 API 互換)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false, meta: null,
    }))
    const r = await api.mediaAnalyze('c', 'b', 'a.wav')
    expect(r.meta).toBeNull()
  })

  it('mediaAnalyze: entryPath がクエリに乗る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false, meta: null,
    }))
    await api.mediaAnalyze('c', 'b', 'shard.tar', { entryPath: 'u1.wav' })
    expect(String(spy.mock.calls[0][0])).toContain('entryPath=u1.wav')
  })

  it('spectrogramUrl を組み立てる', () => {
    expect(api.spectrogramUrl('c', 'ck')).toBe('/api/internal/storage/c/media/spectrogram?cacheKey=ck')
  })
})
