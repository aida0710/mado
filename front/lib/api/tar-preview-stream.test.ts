import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTarPreviewStream } from './tar-preview-stream'

const first = { name: 'a.mp4', size: 1024 ** 3, type: 'file' }
const second = { name: 'b.mp4', size: 1024 ** 3, type: 'file' }
const response = (records: unknown[]) => new Response(records.map(record => JSON.stringify(record)).join('\n') + '\n')

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('tar一覧の再開', () => {
  it('途中の索引を再開しても取得済みのファイルを重複表示しない', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response([{ mode: 'range' }, { entry: first }, { pending: true }]))
      .mockResolvedValueOnce(response([
        { mode: 'range' }, { entry: first }, { entry: second },
        { done: { truncated: false, hasMore: false, offset: 0, limit: 100 } },
      ]))
    const onEntry = vi.fn()
    const listing = loadTarPreviewStream('/preview/tar', { onEntry })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await listing).entries).toEqual([first, second])
    expect(onEntry.mock.calls).toEqual([[first], [second]])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('準備中にtarが変わったら、異なる一覧を混ぜず更新を求める', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response([{ entry: first }, { pending: true }]))
      .mockResolvedValueOnce(response([{ entry: second }, { done: { truncated: false, hasMore: false, offset: 0, limit: 100 } }]))
    const listing = loadTarPreviewStream('/preview/tar', {})
    const rejected = expect(listing).rejects.toThrow('tarが更新されました')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
