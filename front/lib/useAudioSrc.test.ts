import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioSrc } from './useAudioSrc'

describe('useAudioSrc', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    URL.createObjectURL = vi.fn(() => 'blob:mock-1')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('単体ファイルは即座にストリーミング URL を返し、fetch は呼ばれない', () => {
    const { result } = renderHook(() => useAudioSrc('c', 'b', 'a.wav'))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.src).toContain('/preview/audio')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tar エントリは fetch して blob URL になる (loading: true → false)', async () => {
    let resolveFetch!: (v: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { resolveFetch = resolve }))

    const { result } = renderHook(() => useAudioSrc('c', 'b', 'shard.tar', 'u1.wav'))
    expect(result.current.loading).toBe(true)
    expect(result.current.src).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/preview/tar-entry'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    await act(async () => {
      resolveFetch({
        ok: true,
        blob: () => Promise.resolve(new Blob(['data'])),
      } as unknown as Response)
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.src).toBe('blob:mock-1')
    expect(result.current.error).toBeNull()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('アンマウントで revokeObjectURL が呼ばれる', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['data'])),
    } as unknown as Response)

    const { result, unmount } = renderHook(() => useAudioSrc('c', 'b', 'shard.tar', 'u1.wav'))
    await waitFor(() => expect(result.current.src).toBe('blob:mock-1'))

    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('fetch 失敗時は error がセットされ src は null のまま', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      json: () => Promise.resolve({ error: 'entry not found' }),
    } as unknown as Response)

    const { result } = renderHook(() => useAudioSrc('c', 'b', 'shard.tar', 'u1.wav'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('entry not found')
    expect(result.current.src).toBeNull()
  })
})
