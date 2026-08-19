import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewDrawer } from './PreviewDrawer'
import { ConnectionContext } from '../lib/connectionContext'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import type { Capabilities, Connection } from '../lib/api/types'

// 中身のプレビューは別テストの領分。ここでは「何が出て何が出ないか」だけ見る。
vi.mock('./PreviewText',    () => ({ PreviewText:    () => <div>text-preview</div> }))
vi.mock('./PreviewImage',   () => ({ PreviewImage:   () => <div>image-preview</div> }))
vi.mock('./PreviewAudio',   () => ({ PreviewAudio:   () => <div>audio-preview</div> }))
vi.mock('./PreviewArchive', () => ({ PreviewArchive: () => <div>archive-preview</div> }))

afterEach(() => vi.restoreAllMocks())

function renderDrawer(caps: Partial<Capabilities>, k = 'a/b.txt') {
  const conn: Connection = {
    id: 'c1', name: 'primary', endpoint: 'https://s3.example.com/', region: 'auto',
    accessKeyIdMasked: 'AKIA…2345', forcePathStyle: true, listObjectsVersion: 'v2',
    capabilities: { ...ALL_CAPABILITIES_ON, ...caps },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
    scanEnabled: true, listCacheTtlSec: 86400,
  }
  return render(
    <ConnectionContext.Provider value={conn}>
      <PreviewDrawer connId="c1" bucket="bkt" k={k} onClose={() => {}} />
    </ConnectionContext.Provider>,
  )
}

describe('PreviewDrawer の権限による出し分け', () => {
  it('既定 (全許可) では DL ボタンとプレビュー本体が出る', () => {
    renderDrawer({})
    expect(screen.getByLabelText('b.txt をダウンロード')).toBeInTheDocument()
    expect(screen.getByText('text-preview')).toBeInTheDocument()
  })

  it('ダウンロードが無効なら DL ボタンだけ消える (プレビューは残る)', () => {
    renderDrawer({ download: false })
    expect(screen.queryByLabelText('b.txt をダウンロード')).not.toBeInTheDocument()
    expect(screen.getByText('text-preview')).toBeInTheDocument()
  })

  it('プレビューが無効なら本体を出さず理由を表示する', () => {
    renderDrawer({ preview: false })
    expect(screen.queryByText('text-preview')).not.toBeInTheDocument()
    expect(screen.getByText(/ファイルのプレビュー/)).toBeInTheDocument()
  })

  it('圧縮ファイルは preview ではなく archive 権限で開ける', () => {
    renderDrawer({ preview: false }, 'a/shard.tar')
    expect(screen.getByText('archive-preview')).toBeInTheDocument()
  })

  it('archive が無効なら圧縮ファイルは開けない', () => {
    renderDrawer({ archive: false }, 'a/shard.tar')
    expect(screen.queryByText('archive-preview')).not.toBeInTheDocument()
    expect(screen.getByText(/圧縮ファイルを開くこと/)).toBeInTheDocument()
  })

  it('接続の情報が無い (context 外) なら既定の全許可で描く', async () => {
    // 実際の遮断は API 側 (403) が担うので、UI は楽観的でよい。
    vi.spyOn(await import('../lib/api/client').then(m => m.api), 'listConnections')
      .mockResolvedValue([])
    render(<PreviewDrawer connId="c1" bucket="bkt" k="a/b.txt" onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByLabelText('b.txt をダウンロード')).toBeInTheDocument())
  })
})
