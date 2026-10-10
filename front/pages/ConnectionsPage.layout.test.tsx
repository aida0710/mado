import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './ConnectionsPage'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'
import { PRICING_FIXTURE } from '../lib/api/fixtures'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: { ...mod.api, listConnections: vi.fn(), setDefaultConnection: vi.fn() },
  }
})

afterEach(() => vi.clearAllMocks())

// R2 の endpoint は空白なしで 60 文字超になる。
const LONG_ENDPOINT = 'https://07d0626c8c662f767b2d07796dc0d087.r2.cloudflarestorage.com'

const connection = {
  id: 'r2', name: 'cloudflare r2', endpoint: LONG_ENDPOINT, region: 'auto',
  accessKeyIdMasked: '20a1…7a30', forcePathStyle: true, listObjectsVersion: 'v2' as const,
  capabilities: ALL_CAPABILITIES_ON,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
  visibility: { mode: 'public' as const, allowedUsers: [] },
  scanEnabled: true, listCacheTtlSec: 86400,
  pricing: PRICING_FIXTURE,
}

// 画面幅を決めて描く。テストの matchMedia は既定でどのクエリにも一致する (= 狭い画面)。
function setScreenWidth(width: 'wide' | 'narrow') {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: width === 'narrow', media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }))
}

describe('ConnectionsPage の一覧の表', () => {
  afterEach(() => vi.mocked(window.matchMedia).mockRestore?.())

  it('広い画面では名前・エンドポイント・リージョン・操作を一行に並べる', async () => {
    setScreenWidth('wide')
    vi.mocked(api.listConnections).mockResolvedValue([connection])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)

    const row = (await screen.findByText('cloudflare r2')).closest('tr') as HTMLElement
    expect(within(row).getByText(LONG_ENDPOINT)).toBeInTheDocument()
    expect(within(row).getByText('auto')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: '開く' })).toHaveAttribute('href', '/storage/r2/')
    expect(within(row).getByRole('button', { name: 'デフォルトにする' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '詳細を表示' })).not.toBeInTheDocument()
  })

  // jsdom はレイアウトを行わないので「実際にはみ出すか」は測れない。ここでは
  // はみ出しを防いでいる指定が消えていないことだけを固定する (実際の幅での確認は
  // スクリーンショットで行う)。
  it('長い endpoint を語中で折り返せるようにしている', async () => {
    setScreenWidth('wide')
    vi.mocked(api.listConnections).mockResolvedValue([connection])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)

    // 空白を含まない endpoint は、語中で折り返せないと表の幅を押し広げる。
    expect(await screen.findByText(LONG_ENDPOINT)).toHaveClass('break-word')
  })

  it('狭い画面では名前だけを行に残し、エンドポイントと操作は行の下に開く', async () => {
    setScreenWidth('narrow')
    vi.mocked(api.listConnections).mockResolvedValue([connection])
    render(<MemoryRouter><ConnectionsPage /></MemoryRouter>)

    await screen.findByText('cloudflare r2')
    expect(screen.queryByText(LONG_ENDPOINT)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '開く' })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: '詳細を表示' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('詳細を閉じる')
    expect(screen.getByText(LONG_ENDPOINT)).toHaveClass('break-word')
    expect(screen.getByRole('link', { name: '開く' })).toHaveAttribute('href', '/storage/r2/')
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.queryByText(LONG_ENDPOINT)).not.toBeInTheDocument()
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
    const create = vi.spyOn(api, 'createConnection').mockResolvedValue(connection)
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
      visibility: { mode: 'public', allowedUserIds: [] },
    }))
    expect(await screen.findByText('追加 1 件 / スキップ 0 件')).toBeInTheDocument()
  })
})
