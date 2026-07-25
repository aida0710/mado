import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { ConnectionContext } from '../lib/connectionContext'
import StorageIndex from './StorageIndex'

afterEach(() => vi.restoreAllMocks())

// StorageIndex は <ConnectionSwitcher/> 経由で useConnection() を呼ぶため、
// ConnectionContext.Provider 配下でないとレンダリング時に例外を投げる
// (Breadcrumb.test.tsx / StoragePage.tsx と同じパターン)。
const conn: Connection = {
  id: 'c1',
  name: 'c1',
  endpoint: 'https://example.com',
  region: 'auto',
  accessKeyIdMasked: '****',
  forcePathStyle: true,
  listObjectsVersion: 'v2',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isDefault: false,
}

function renderIndex() {
  return render(
    <MemoryRouter>
      <ConnectionContext.Provider value={conn}>
        <StorageIndex connId="c1" />
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('StorageIndex タグ', () => {
  it('バケット行にタグバッジを表示する', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'bkt-1', creationDate: null }] })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    // tagAssignments はレスポンスを path 単位で返す (kind='bucket' の path は常に '')。
    // StorageBrowser.tags.test.tsx と同じ形。
    vi.spyOn(api, 'tagAssignments').mockResolvedValue({ '': ['t1'] })
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    renderIndex()
    // 「重要」は TagFilterBar の候補チップと BucketLi の行バッジの両方に
    // 出現するため、findByText (単数) だと "Found multiple elements" になる
    // (StorageBrowser.tags.test.tsx と同じ事情)。ここでは「少なくとも 1 箇所に
    // バッジ表示されている」ことだけを確認する。
    const badges = await screen.findAllByText('重要')
    expect(badges.length).toBeGreaterThan(0)
  })

  it('タグチップで絞り込むと一致しないバケットが隠れる', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({
      buckets: [{ name: 'bkt-1', creationDate: null }, { name: 'bkt-2', creationDate: null }],
    })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    // bkt-1 のみタグ付き。bucket 引数で分岐させ、path キー ('') で返す
    // (StorageBrowser.tags.test.tsx と同じ mockImplementation パターン)。
    vi.spyOn(api, 'tagAssignments').mockImplementation(async (_connId, bucket): Promise<Record<string, string[]>> =>
      bucket === 'bkt-1' ? { '': ['t1'] } : {})
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    renderIndex()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())
    expect(screen.getByText('bkt-2')).toBeInTheDocument()

    // タグ付与状況はバケット一覧より 1 render 遅れて非同期に届く (buckets state
    // が確定してから別 effect が発火する) ため、getByRole (同期) だと稀に間に合わない。
    // findByRole でタグチップの到着を待ってからクリックする。
    fireEvent.click(await screen.findByRole('button', { name: '重要' }))

    expect(screen.getByText('bkt-1')).toBeInTheDocument()
    expect(screen.queryByText('bkt-2')).not.toBeInTheDocument()
  })
})
