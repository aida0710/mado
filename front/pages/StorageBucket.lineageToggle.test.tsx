import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import StorageBucket from './StorageBucket'

afterEach(() => vi.restoreAllMocks())

// StorageBucket は中で StorageBrowser / ReadmeView / PreviewDrawer を描画するが、
// ここで見たいのはタブの出し分けだけなので、重い子要素はモックで潰す。
vi.mock('../components/StorageBrowser', () => ({ StorageBrowser: () => <div /> }))
vi.mock('../components/ReadmeView', () => ({ ReadmeView: () => <div /> }))
vi.mock('../components/PreviewDrawer', () => ({ PreviewDrawer: () => <div /> }))
vi.mock('../components/Breadcrumb', () => ({ Breadcrumb: () => <div /> }))
vi.mock('../components/ConnectionSwitcher', () => ({ ConnectionSwitcher: () => <div /> }))
vi.mock('../components/storage/lineage/LineageView', () => ({
  LineageView: () => <div>家系図ビュー</div>,
}))

function renderBucket(initialUrl = '/storage/c1/bkt/') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/storage/:connId/:bucket/*" element={<StorageBucket connId="c1" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StorageBucket 家系図タブの出し分け', () => {
  it('設定が有効なら家系図タブを出す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'true' })
    renderBucket()
    expect(await screen.findByRole('tab', { name: /家系図/ })).toBeInTheDocument()
  })

  it('設定が無効なら家系図タブを消す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'false' })
    renderBucket()
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /家系図/ })).not.toBeInTheDocument())
    // 「一覧」タブは残る。
    expect(screen.getByRole('tab', { name: '一覧' })).toBeInTheDocument()
  })

  // タブが無いのに家系図が出ている迷子状態を作らない。
  it('無効時は ?view=lineage で直リンクされても一覧に倒す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'false' })
    renderBucket('/storage/c1/bkt/?view=lineage')
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: /家系図/ })).not.toBeInTheDocument())
    expect(screen.queryByText('家系図ビュー')).not.toBeInTheDocument()
  })

  it('有効時は ?view=lineage で家系図ビューを出す', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ lineage_enabled: 'true' })
    renderBucket('/storage/c1/bkt/?view=lineage')
    expect(await screen.findByText('家系図ビュー')).toBeInTheDocument()
  })

  // 設定 API が落ちても既存機能は使えるままにする。
  it('設定の取得に失敗したら既定 (有効) のまま', async () => {
    vi.spyOn(api, 'settings').mockRejectedValue(new Error('boom'))
    renderBucket()
    expect(await screen.findByRole('tab', { name: /家系図/ })).toBeInTheDocument()
  })
})
