import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('media client', () => {
  it('mediaAnalyze: URL / signal / zod parse', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 2, sampleRate: 16000, hasSpectrogram: true,
    }))
    const ctl = new AbortController()
    const r = await api.mediaAnalyze('c 1', 'b', 'dir/a.wav', { signal: ctl.signal })
    expect(r.cacheKey).toBe('ck')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/c%201/media/analyze?bucket=b&key=dir%2Fa.wav')
    expect((init as RequestInit).signal).toBe(ctl.signal)
  })

  it('mediaAnalyze: entryPath がクエリに乗る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false,
    }))
    await api.mediaAnalyze('c', 'b', 'shard.tar', { entryPath: 'u1.wav' })
    expect(String(spy.mock.calls[0][0])).toContain('entryPath=u1.wav')
  })

  it('spectrogramUrl を組み立てる', () => {
    expect(api.spectrogramUrl('c', 'ck')).toBe('/api/internal/storage/c/media/spectrogram?cacheKey=ck')
  })

  it('scanStart は POST、scanStatus は zod で検証', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 7 }), { status: 202 }))
      .mockResolvedValueOnce(okJson({ job: null, stats: null, scannedAt: null }))
    const started = await api.scanStart('c', { bucket: 'b', prefix: 'ds/' })
    expect(started.jobId).toBe(7)
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST')
    const st = await api.scanStatus('c', 'b', { prefix: 'ds/' })
    expect(st.job).toBeNull()
  })

  it('scanStatus: prefix がエンコードされてクエリに乗る', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ job: null, stats: null, scannedAt: null }),
    )
    await api.scanStatus('c', 'b', { prefix: 'ds/' })
    expect(String(spy.mock.calls[0][0])).toContain('prefix=ds%2F')
  })

  it('scanStatus: バケット直下 (target 空) でも prefix= が送られる', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ job: null, stats: null, scannedAt: null }),
    )
    await api.scanStatus('c', 'b', {})
    // buildUrl は空文字パラメータを落とす — 空でも prefix= が残ることを保証する (回帰防止)。
    expect(String(spy.mock.calls[0][0])).toContain('prefix=')
  })

  it('scanStatus: tarKey 指定時は tarKey が乗り prefix は乗らない', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({ job: null, stats: null, scannedAt: null }),
    )
    await api.scanStatus('c', 'b', { tarKey: 'shard.tar' })
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('tarKey=shard.tar')
    expect(url).not.toContain('prefix')
  })

  it('scanStatus: 非 null の job + progress を zod で parse する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      job: {
        id: 1,
        status: 'processing',
        progress: { filesDone: 3, filesTotal: 10, currentKey: 'x.wav' },
        error: null,
      },
      stats: null,
      scannedAt: null,
    }))
    const st = await api.scanStatus('c', 'b', { prefix: 'ds/' })
    expect(st.job).not.toBeNull()
    expect(st.job!.id).toBe(1)
    expect(st.job!.status).toBe('processing')
    expect(st.job!.progress).toEqual({ filesDone: 3, filesTotal: 10, currentKey: 'x.wav' })
    expect(st.job!.error).toBeNull()
  })
})
