import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './ConnectionsPage'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: { ...mod.api, listConnections: vi.fn(), setDefaultConnection: vi.fn() },
  }
})

afterEach(() => vi.clearAllMocks())

// R2 の endpoint は空白なしで 60 文字超になる。
const LONG_ENDPOINT = 'https://07d0626c8c662f767b2d07796dc0d087.r2.cloudflarestorage.com'

const conn = {
  id: 'r2', name: 'cloudflare r2', endpoint: LONG_ENDPOINT, region: 'auto',
  accessKeyIdMasked: '20a1…7a30', forcePathStyle: true, listObjectsVersion: 'v2' as const,
  capabilities: ALL_CAPABILITIES_ON,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
  scanEnabled: true, listCacheTtlSec: 86400,
}

// jsdom はレイアウトを行わないので「実際にはみ出すか」は測れない。ここでは
// はみ出しを防いでいる指定が消えていないことだけを固定する (実レンダリングでの
// 確認はスマホ幅のスクリーンショットで実施済み)。
describe('ConnectionsPage の狭い画面向けレイアウト', () => {
  it('長い endpoint を語中で折り返せるようにしている', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)

    await waitFor(() => expect(screen.getByText('cloudflare r2')).toBeInTheDocument())
    const row = screen.getByText('cloudflare r2').closest('li') as HTMLElement

    // endpoint は ` · ` 区切りの meta 行に他の項目と混在するので、テキストではなく
    // 「折り返し指定を持つ要素が endpoint を含んでいる」ことで引く。
    // wrap-anywhere が無いと、空白を含まない endpoint は折り返せず画面外へ出る。
    const meta = row.querySelector('.wrap-anywhere')
    expect(meta).not.toBeNull()
    expect(meta?.textContent).toContain(LONG_ENDPOINT)
  })

  it('狭い画面では行を縦積みにし、ボタン群も折り返せるようにしている', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('cloudflare r2')).toBeInTheDocument())

    const row = screen.getByText('cloudflare r2').closest('li') as HTMLElement
    // 既定は縦積み、sm 以上で従来の横並びに戻す。
    expect(row.className).toContain('flex-col')
    expect(row.className).toContain('sm:flex-row')

    // 4 ボタンが 360px に収まらないので折り返しを許可する。
    const buttons = screen.getByText('削除').closest('div') as HTMLElement
    expect(buttons.className).toContain('flex-wrap')
  })
})

// 接続定義を環境間で持ち運ぶための入出力。
describe('ConnectionsPage インポート / エクスポート', () => {
  const pickFile = async (json: unknown, mode: '追記' | '置き換え' = '追記') => {
    const input = screen.getByLabelText('接続をインポート') as HTMLInputElement
    const file = new File([JSON.stringify(json)], 'x.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    // ファイルを選ぶと取り込み方法を聞かれる。既定は追記。
    fireEvent.click(await screen.findByRole('button', { name: mode }))
  }

  it('mado のファイルでなければ取り込まない', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await screen.findByLabelText('接続をインポート')

    await pickFile({ hello: 'world' })
    expect(await screen.findByRole('alert')).toHaveTextContent('エクスポートファイルではありません')
  })

  // エクスポートは雛形なので鍵が空。そのまま取り込もうとしたら理由を出す
  // (API の min(1) エラーをそのまま見せない)。
  it('鍵が空の項目は理由つきで失敗として数える', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await screen.findByLabelText('接続をインポート')

    await pickFile({
      mado: 'connections', version: 1,
      connections: [{
        name: 'r2', endpoint: 'https://e', region: 'auto',
        accessKeyId: '', secretAccessKey: '',
        forcePathStyle: true, listObjectsVersion: 'v2',
      }],
    })

    expect(await screen.findByText(/失敗 1 件/)).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('シークレットキーが空')
  })

  it('鍵を書き足した項目は createConnection で作る', async () => {
    vi.mocked(api.listConnections).mockResolvedValue([])
    const create = vi.spyOn(api, 'createConnection').mockResolvedValue(conn)
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)
    await screen.findByLabelText('接続をインポート')

    await pickFile({
      mado: 'connections', version: 1,
      connections: [{
        name: 'r2', endpoint: 'https://e', region: 'auto',
        accessKeyId: 'AKIA', secretAccessKey: 'sec',
        forcePathStyle: true, listObjectsVersion: 'v2',
      }],
    })

    // capabilities を持たない (v1 初期の) エクスポートは全許可として取り込む。
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: 'r2', endpoint: 'https://e', region: 'auto',
      accessKeyId: 'AKIA', secretAccessKey: 'sec',
      forcePathStyle: true, listObjectsVersion: 'v2',
      capabilities: ALL_CAPABILITIES_ON,
    }))
    expect(await screen.findByText('追加 1 件 / スキップ 0 件')).toBeInTheDocument()
  })
})
