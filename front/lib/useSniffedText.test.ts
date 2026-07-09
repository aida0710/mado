import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSniffedText } from './useSniffedText'

vi.mock('./api/client', () => ({
  api: { readHead: vi.fn() },
}))

import { api } from './api/client'

afterEach(() => vi.clearAllMocks())

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('useSniffedText', () => {
  it('最初は loading', () => {
    vi.mocked(api.readHead).mockReturnValue(new Promise<Uint8Array>(() => {}))
    const { result } = renderHook(() => useSniffedText('/x'))
    expect(result.current.status).toBe('loading')
  })

  it('NUL を含まなければ text (不可逆 UTF-8 デコード)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('こんにちは\n世界'))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('text'))
    expect(result.current).toEqual({ status: 'text', text: 'こんにちは\n世界' })
  })

  it('NUL を含めば binary', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('binary'))
  })

  it('取得に失敗したら error', async () => {
    vi.mocked(api.readHead).mockRejectedValue(new Error('Not Found'))
    const { result } = renderHook(() => useSniffedText('/x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toEqual({ status: 'error', message: 'Not Found' })
  })

  it('先頭 TEXT_HEAD_BYTES だけ要求する', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hi'))
    renderHook(() => useSniffedText('/some/url'))
    await waitFor(() => expect(api.readHead).toHaveBeenCalledWith('/some/url', 65536))
  })
})
