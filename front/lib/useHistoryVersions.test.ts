import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useHistoryVersions, type HistoryVersionBody } from './useHistoryVersions'

const versions = [
  { id: 3, editor: 'c', edited_at: '2026-09-18T00:00:00Z', size_bytes: 30 },
  { id: 2, editor: 'b', edited_at: '2026-09-17T00:00:00Z', size_bytes: 20 },
  { id: 1, editor: 'a', edited_at: '2026-09-16T00:00:00Z', size_bytes: 10 },
]

/** 版ごとの本文を、テストが好きなタイミングで解決できる Promise で返す。 */
function deferredVersions() {
  const resolvers = new Map<number, (body: HistoryVersionBody) => void>()
  const loadVersion = vi.fn(
    (id: number) => new Promise<HistoryVersionBody>(resolve => { resolvers.set(id, resolve) }),
  )
  const resolve = (id: number) => resolvers.get(id)!({ id, body: `body-${id}` })
  return { loadVersion, resolve }
}

describe('useHistoryVersions', () => {
  it('一覧が届くと最新の版を選び、その本文を読む', async () => {
    const loadVersions = vi.fn(async () => versions)
    const loadVersion = vi.fn(async (id: number) => ({ id, body: `body-${id}` }))
    const { result } = renderHook(() => useHistoryVersions({ loadVersions, loadVersion }))

    expect(result.current.state.versions).toBeNull()
    await waitFor(() => expect(result.current.state.selectedBody).toEqual({ id: 3, body: 'body-3' }))
    expect(result.current.state.selectedId).toBe(3)
    expect(loadVersion).toHaveBeenCalledTimes(1)
  })

  it('版を切り替えると本文を消してから新しい本文を読む', async () => {
    const loadVersions = vi.fn(async () => versions)
    const { loadVersion, resolve } = deferredVersions()
    const { result } = renderHook(() => useHistoryVersions({ loadVersions, loadVersion }))
    await waitFor(() => expect(loadVersion).toHaveBeenCalledWith(3))
    await act(async () => resolve(3))
    expect(result.current.state.selectedBody?.id).toBe(3)

    act(() => result.current.selectVersion(1))
    expect(result.current.state.selectedId).toBe(1)
    expect(result.current.state.selectedBody).toBeNull()
    await act(async () => resolve(1))
    expect(result.current.state.selectedBody).toEqual({ id: 1, body: 'body-1' })
  })

  it('先に選んだ版の本文が遅れて届いても、今選んでいる版を上書きしない', async () => {
    const loadVersions = vi.fn(async () => versions)
    const { loadVersion, resolve } = deferredVersions()
    const { result } = renderHook(() => useHistoryVersions({ loadVersions, loadVersion }))
    await waitFor(() => expect(loadVersion).toHaveBeenCalledWith(3))

    act(() => result.current.selectVersion(2))
    await waitFor(() => expect(loadVersion).toHaveBeenCalledWith(2))
    await act(async () => resolve(3))
    expect(result.current.state.selectedBody).toBeNull()
    await act(async () => resolve(2))
    expect(result.current.state.selectedBody).toEqual({ id: 2, body: 'body-2' })
  })

  it('一覧が空なら何も選ばず本文も読まない', async () => {
    const loadVersions = vi.fn(async () => [])
    const loadVersion = vi.fn(async (id: number) => ({ id, body: '' }))
    const { result } = renderHook(() => useHistoryVersions({ loadVersions, loadVersion }))
    await waitFor(() => expect(result.current.state.versions).toEqual([]))
    expect(result.current.state.selectedId).toBeNull()
    expect(loadVersion).not.toHaveBeenCalled()
  })

  it('取得に失敗すると error に理由が入る', async () => {
    const loadVersions = vi.fn(async () => { throw new Error('boom') })
    const loadVersion = vi.fn(async (id: number) => ({ id, body: '' }))
    const { result } = renderHook(() => useHistoryVersions({ loadVersions, loadVersion }))
    await waitFor(() => expect(result.current.state.error).toBe('boom'))
  })
})
