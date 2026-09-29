import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeUnauthorized } from './api/unauthorized-events'
import { useMediaSrc } from './useMediaSrc'

const ARCHIVE_ENTRY_URL = '/api/internal/storage/c/tar-entry?bucket=b&key=a.tar&entry=clip.mp4'

function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMediaSrc — 書庫内のエントリ', () => {
  it('取得が 401 なら、session を確かめるよう AuthGate へ知らせる', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    const onUnauthorized = vi.fn()
    const unsubscribe = subscribeUnauthorized(onUnauthorized)

    const { result } = renderHook(() => useMediaSrc(null, ARCHIVE_ENTRY_URL))

    await waitFor(() => expect(result.current.loading).toBe(false))
    unsubscribe()
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('取得できなければ、サーバーのエラー文言を返す', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'entry not found' }), { status: 404, statusText: 'Not Found' }))

    const { result } = renderHook(() => useMediaSrc(null, ARCHIVE_ENTRY_URL))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toEqual({ src: null, loading: false, error: 'entry not found' })
  })

  it('エラーの本文が JSON でなければ、HTTP のステータス文言を返す', async () => {
    stubFetch(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }))

    const { result } = renderHook(() => useMediaSrc(null, ARCHIVE_ENTRY_URL))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Bad Gateway')
  })
})
