import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { ConnectionContext } from '../lib/connectionContext'
import { copyToClipboard } from '../lib/clipboard'
import StorageIndex from './StorageIndex'

vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

afterEach(() => vi.restoreAllMocks())

// StorageIndex.tags.test.tsx と同じ Provider 構成 (ConnectionSwitcher が
// useConnection() を呼ぶため Provider 配下でないと例外になる)。
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

function mountWithOneBucket() {
  vi.spyOn(api, 'buckets').mockResolvedValue({ buckets: [{ name: 'bkt-1', creationDate: null }] })
  vi.spyOn(api, 'favorites').mockResolvedValue([])
  vi.spyOn(api, 'tags').mockResolvedValue([])
  vi.spyOn(api, 'tagAssignments').mockResolvedValue({})
  vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
    list: () => null, readme: () => null, tar: () => null, buckets: () => null,
  })
  return render(
    <MemoryRouter>
      <ConnectionContext.Provider value={conn}>
        <StorageIndex connId="c1" />
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('StorageIndex バケット行の ⋯ メニュー', () => {
  it('タグ編集と URL コピーを 1 つのメニューにまとめて出す', async () => {
    const user = userEvent.setup()
    mountWithOneBucket()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'アクション' }))

    expect(screen.getByRole('menuitem', { name: 'タグを編集' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Web URL をコピー/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /S3 URL をコピー/ })).toBeInTheDocument()
  })

  it('S3 URL はパンくずと同じ末尾スラッシュ付きの形でコピーする', async () => {
    const user = userEvent.setup()
    mountWithOneBucket()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'アクション' }))
    await user.click(screen.getByRole('menuitem', { name: /S3 URL をコピー/ }))

    // Breadcrumb は prefix='' のとき `s3://<bucket>/` を出す。バケット一覧も同形に揃える。
    expect(copyToClipboard).toHaveBeenCalledWith('s3://bkt-1/')
  })

  it('Web URL はバケット直下を指す絶対 URL をコピーする', async () => {
    const user = userEvent.setup()
    mountWithOneBucket()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'アクション' }))
    await user.click(screen.getByRole('menuitem', { name: /Web URL をコピー/ }))

    expect(copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/storage/c1/bkt-1/`)
  })

  it('メニューの「タグを編集」から TagPicker を開ける', async () => {
    const user = userEvent.setup()
    mountWithOneBucket()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'アクション' }))
    await user.click(screen.getByRole('menuitem', { name: 'タグを編集' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('独立した 🏷 ボタンは廃止して ⋯ に統合されている', async () => {
    mountWithOneBucket()
    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())

    // 行に生えるアクションは ⋯ ひとつだけ (旧 aria-label='タグを編集' の裸ボタンは無い)。
    expect(screen.queryByRole('button', { name: 'タグを編集' })).not.toBeInTheDocument()
  })
})
