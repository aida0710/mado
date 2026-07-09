import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

// 指定チャンクを順に流す ReadableStream もどき。cancel の呼び出しを記録する。
function streamOf(chunks: number[][]) {
  let i = 0
  const cancel = vi.fn(async () => {})
  return {
    cancel,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new Uint8Array(chunks[i++]) }
            : { done: true, value: undefined },
        cancel,
      }),
    },
  }
}

function res(chunks: number[][], init: { ok?: boolean; statusText?: string } = {}) {
  const s = streamOf(chunks)
  return {
    fake: {
      ok: init.ok ?? true,
      statusText: init.statusText ?? 'OK',
      body: s.body,
      json: async () => ({}),
    } as unknown as Response,
    cancel: s.cancel,
  }
}

describe('api.readHead', () => {
  it('maxBytes で打ち切り、残りのストリームを cancel する', async () => {
    const { fake, cancel } = res([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    const head = await api.readHead('/x', 4)

    expect([...head]).toEqual([1, 2, 3, 4])
    expect(cancel).toHaveBeenCalled()
  })

  it('maxBytes 未満のレスポンスは done まで読む', async () => {
    const { fake } = res([[1, 2], [3]])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    const head = await api.readHead('/x', 1024)

    expect([...head]).toEqual([1, 2, 3])
  })

  it('空レスポンスは空の Uint8Array', async () => {
    const { fake } = res([])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    expect((await api.readHead('/x', 1024)).length).toBe(0)
  })

  it('4xx / 5xx は statusText で throw する', async () => {
    const { fake } = res([], { ok: false, statusText: 'Not Found' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    await expect(api.readHead('/x', 1024)).rejects.toThrow('Not Found')
  })

  it('エラー body に error があればそれを使う', async () => {
    const fake = {
      ok: false,
      statusText: 'Payload Too Large',
      json: async () => ({ error: 'entry exceeds preview limit' }),
    } as unknown as Response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fake)

    await expect(api.readHead('/x', 1024)).rejects.toThrow('entry exceeds preview limit')
  })
})
