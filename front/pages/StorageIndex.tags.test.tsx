import { render, screen, waitFor } from '@testing-library/react'
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
    // TagPanel は既定で畳んでおり候補チップを出さないので、ここで見つかる
    // 「重要」は BucketLi の行バッジ。
    const badges = await screen.findAllByText('重要')
    expect(badges.length).toBeGreaterThan(0)
  })

  // タグ検索とデータ家系図は畳んだパネルをやめて別ビューへのリンクにした
  // (一覧の前に積み上がってページが混み合っていたため)。
  it('タグ検索とデータ家系図はリンクとして出す', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'bkt-1', creationDate: null }] })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([])
    vi.spyOn(api, 'tagAssignments').mockResolvedValue({})
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'true' })
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    renderIndex()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    expect(await screen.findByRole('link', { name: 'タグ検索' }))
      .toHaveAttribute('href', '/?view=tags')
    expect(screen.getByRole('link', { name: 'データ家系図' }))
      .toHaveAttribute('href', '/?view=lineage')
  })

  it('家系図が無効ならデータ家系図のリンクを出さない', async () => {
    vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'bkt-1', creationDate: null }] })
    vi.spyOn(api, 'favorites').mockResolvedValue([])
    vi.spyOn(api, 'tags').mockResolvedValue([])
    vi.spyOn(api, 'tagAssignments').mockResolvedValue({})
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'false' })
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    renderIndex()
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'データ家系図' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'タグ検索' })).toBeInTheDocument()
  })
})
