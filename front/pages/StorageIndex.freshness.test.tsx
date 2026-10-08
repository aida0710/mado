import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import StorageIndex from './StorageIndex'

vi.mock('../components/ConnectionSwitcher', () => ({ ConnectionSwitcher: () => null }))

const oldFetchedAt = '2026-10-07T00:00:00.000Z'
const newFetchedAt = '2026-10-08T00:00:00.000Z'
const bucketList = (name: string, fetchedAt: string) => ({
  buckets: [{ name, creationDate: null }],
  cache: { fetchedAt, expiresAt: '2099-10-08T00:00:00.000Z', hit: true },
})

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(accept => { resolve = accept })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

function renderIndex() {
  vi.spyOn(api, 'tags').mockResolvedValue([])
  vi.spyOn(api, 'tagAssignments').mockResolvedValue({})
  vi.spyOn(api, 'settings').mockResolvedValue({})
  return render(<MemoryRouter><StorageIndex connectionId="c1" /></MemoryRouter>)
}

describe('バケット一覧の鮮度', () => {
  it('表示中の一覧のS3取得時刻を表示する', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue(bucketList('old-bucket', oldFetchedAt))
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api.lastFetched, 'buckets').mockReturnValue(new Date(newFetchedAt))
    const { container } = renderIndex()

    await screen.findByRole('link', { name: 'old-bucket' })
    expect(container.querySelector('time')).toHaveAttribute('datetime', oldFetchedAt)
  })

  it('お気に入りが遅れて届いても再取得済みの一覧を古い一覧へ戻さない', async () => {
    const fresh = deferred<ReturnType<typeof bucketList>>()
    const favorites = deferred<string[]>()
    vi.spyOn(api, 'buckets').mockImplementation(async (_connectionId, options) => {
      options?.onRevalidate?.(fresh.promise)
      return bucketList('old-bucket', oldFetchedAt)
    })
    vi.spyOn(api, 'favorites').mockReturnValue(favorites.promise)
    vi.spyOn(api.lastFetched, 'buckets').mockReturnValue(new Date(newFetchedAt))
    const { container } = renderIndex()

    await act(async () => fresh.resolve(bucketList('new-bucket', newFetchedAt)))
    await act(async () => favorites.resolve([]))

    await waitFor(() => expect(screen.getByRole('link', { name: 'new-bucket' })).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'old-bucket' })).toBeNull()
    expect(container.querySelector('time')).toHaveAttribute('datetime', newFetchedAt)
  })
})
