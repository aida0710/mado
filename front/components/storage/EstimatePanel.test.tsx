import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EstimatePanel } from './EstimatePanel'
import { api } from '../../lib/api/client'
import type { TransferCandidate, TransferEstimate } from '../../lib/api/types'

vi.mock('../../lib/api/client', () => ({
  api: { estimate: vi.fn(), refreshPricing: vi.fn(), getJob: vi.fn() },
}))

const GIB = 1024 ** 3

const MANUAL_FACTS = {
  verifiedOn: '2026-08-22',
  notes: ['AWS の最小保存期間', 'Wasabi の単価とポリシー'],
  sources: ['https://aws.amazon.com/s3/pricing/', 'https://wasabi.com/pricing/faq'],
}

function candidate(over: Partial<TransferCandidate> = {}): TransferCandidate {
  return {
    connectionId: 'dst', name: 'jamstec-s3', provider: 'onprem',
    storageClass: null, storageClassLabel: null, sameConnection: false,
    durationSec: { optimistic: 3600 * 18, pessimistic: 3600 * 27 },
    upfront: { egress: 0, retrieval: 0, getRequests: 0, putRequests: 0, total: 0 },
    monthlyUsd: 0, billableBytes: 40 * 1024 * GIB, putRequestCount: 137757,
    avgObjectBytes: 310 * 1024 * 1024, warnings: [],
    ...over,
  }
}

function estimate(candidates: TransferCandidate[], over: Partial<TransferEstimate> = {}): TransferEstimate {
  return {
    source: {
      connectionId: 'src', name: 'mdx-s3', provider: 'onprem',
      storageClass: null, storageClassLabel: null,
    },
    scan: {
      objectCount: 137_757,
      totalBytes: 40 * 1024 * GIB,
      scannedAt: '2026-08-22T01:00:00Z',
    },
    catalog: {
      asOf: '2026-08-22',
      awsPublishedAt: '2026-08-18T18:11:13Z',
      source: 'fetched',
      fetchedAt: '2026-08-22T00:00:00Z',
      stale: false,
      manualFacts: MANUAL_FACTS,
    },
    candidates,
    ...over,
  }
}

function renderPanel(onNeedScan = vi.fn()) {
  return {
    onNeedScan,
    ...render(
      <EstimatePanel connectionId="src" bucket="b" prefix="d/" onNeedScan={onNeedScan} />,
    ),
  }
}

beforeEach(() => {
  vi.mocked(api.estimate).mockReset()
  vi.mocked(api.refreshPricing).mockReset()
  vi.mocked(api.getJob).mockReset()
})

describe('EstimatePanel', () => {
  it('走査済みなら候補が並ぶ', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([
      candidate(),
      candidate({
        connectionId: 'aws', name: 'aws-s3', provider: 'aws',
        storageClass: 'STANDARD', storageClassLabel: 'Standard',
        durationSec: { optimistic: 3600 * 13, pessimistic: 3600 * 20 },
        upfront: { egress: 0, retrieval: 0, getRequests: 0, putRequests: 4.53, total: 4.53 },
        monthlyUsd: 1043,
      }),
    ]))
    renderPanel()

    expect(await screen.findByText('jamstec-s3')).toBeInTheDocument()
    // AWS はストレージクラスを名前に添える。
    expect(screen.getByText('aws-s3 · Standard')).toBeInTheDocument()
    expect(screen.getByText('$1,043')).toBeInTheDocument()
    expect(screen.getByText('18〜27 時間')).toBeInTheDocument()
    expect(screen.getByText('13〜20 時間')).toBeInTheDocument()
  })

  it('走査していなければ走査へ誘導する', async () => {
    vi.mocked(api.estimate).mockResolvedValue(null)
    const { onNeedScan } = renderPanel()

    const button = await screen.findByRole('button', { name: '走査する' })
    await userEvent.click(button)
    expect(onNeedScan).toHaveBeenCalled()
  })

  it('現在地は先頭に出て印が付く', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([
      candidate({ connectionId: 'cheap', name: 'cheap', monthlyUsd: 0 }),
      candidate({ connectionId: 'src', name: 'mdx-s3', sameConnection: true, monthlyUsd: 99 }),
    ]))
    renderPanel()

    await screen.findByText('mdx-s3')
    expect(screen.getByText('現在地')).toBeInTheDocument()
    // 月額が高くても現在地が先。
    const rows = screen.getAllByRole('button', { expanded: false })
    expect(rows[0]).toHaveTextContent('mdx-s3')
  })

  it('残りは月額の安い順に並ぶ', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([
      candidate({ connectionId: 'a', name: 'expensive', monthlyUsd: 1000 }),
      candidate({ connectionId: 'b', name: 'cheap', monthlyUsd: 10 }),
      candidate({ connectionId: 'c', name: 'middle', monthlyUsd: 100 }),
    ]))
    renderPanel()

    await screen.findByText('cheap')
    const rows = screen.getAllByRole('button', { expanded: false })
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('cheap'),
      expect.stringContaining('middle'),
      expect.stringContaining('expensive'),
    ])
  })

  it('行を開くと費用の内訳が出る', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([
      candidate({
        upfront: { egress: 3890, retrieval: 0, getRequests: 0.05, putRequests: 4.53, total: 3894.58 },
        monthlyUsd: 1043,
      }),
    ]))
    renderPanel()

    await userEvent.click(await screen.findByRole('button', { expanded: false }))
    expect(screen.getByText('移動元から出す (egress)')).toBeInTheDocument()
    expect(screen.getByText('$3,890')).toBeInTheDocument()
    // PUT はリクエスト数も添える (マルチパートで実数が効くため)。
    expect(screen.getByText('137,757 回')).toBeInTheDocument()
  })

  it('警告は件数を出し、開くと全文が読める', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([
      candidate({
        warnings: [
          { kind: 'minDuration', message: '最小保存期間 180 日。' },
          { kind: 'archiveRetrievalTime', message: '取り出しは即時ではありません。' },
        ],
      }),
    ]))
    renderPanel()

    expect(await screen.findByLabelText('注意 2 件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('最小保存期間 180 日。')).toBeInTheDocument()
    expect(screen.getByText('取り出しは即時ではありません。')).toBeInTheDocument()
  })

  it('取得済みならその日時を脚注に出す', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()]))
    renderPanel()
    expect(await screen.findByText(/に取得/)).toBeInTheDocument()
  })

  it('まだ取得していなければ同梱だと伝える', async () => {
    // 費用 0 が「無料」なのか「単価を引けていない」のかを取り違えさせない。
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()], {
      catalog: {
        asOf: '2026-08-22', awsPublishedAt: null,
        source: 'bundled', fetchedAt: null, stale: true, manualFacts: MANUAL_FACTS,
      },
    }))
    renderPanel()
    expect(await screen.findByText(/同梱の 2026-08-22 版（まだ取得していません）/))
      .toBeInTheDocument()
  })

  it('単価が古ければ更新を促す', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()], {
      catalog: {
        asOf: '2025-01-01', awsPublishedAt: null,
        source: 'fetched', fetchedAt: '2025-01-01T00:00:00Z', stale: true,
        manualFacts: MANUAL_FACTS,
      },
    }))
    renderPanel()
    expect(await screen.findByText(/単価が古くなっています/)).toBeInTheDocument()
  })

  it('単価を更新すると、完了後に見積もりを取り直す', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()]))
    vi.mocked(api.refreshPricing).mockResolvedValue({ jobId: 7 })
    vi.mocked(api.getJob).mockResolvedValue({ id: 7, status: 'done', result: null })

    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '単価を更新' }))

    await waitFor(() => expect(api.refreshPricing).toHaveBeenCalled())
    // 新しい単価で数字が変わるのを見せたいので、完了を待って取り直す。
    await waitFor(() => expect(api.estimate).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('単価の更新に失敗したら理由を出す (見積もりは残る)', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()]))
    vi.mocked(api.refreshPricing).mockResolvedValue({ jobId: 7 })
    vi.mocked(api.getJob).mockResolvedValue({
      id: 7, status: 'error', result: null, error: 'getaddrinfo ENOTFOUND',
    })

    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: '単価を更新' }))

    // 外に出られない環境ではここに来る。同梱の単価で表は出たまま。
    expect(await screen.findByText(/ENOTFOUND/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('jamstec-s3')).toBeInTheDocument()
  })

  it('平均オブジェクトサイズを出す (所要時間の律速が読めるように)', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()]))
    renderPanel()
    expect(await screen.findByText(/平均 304\.5 MB/)).toBeInTheDocument()
  })

  it('料金 API から取れない値の出所を畳んで出す', async () => {
    vi.mocked(api.estimate).mockResolvedValue(estimate([candidate()]))
    renderPanel()
    // 「取得日が新しい = 全部新しい」と読み違えさせないための注記。
    expect(await screen.findByText(/料金 API から取れないため手入力です（2026-08-22 確認）/))
      .toBeInTheDocument()
    expect(screen.getByText('AWS の最小保存期間')).toBeInTheDocument()
    // 同じドメインの別ページを区別できるよう、パスまで出す。
    expect(screen.getByRole('link', { name: 'wasabi.com/pricing/faq' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'aws.amazon.com/s3/pricing' })).toBeInTheDocument()
  })

  it('失敗したらエラーを出す', async () => {
    vi.mocked(api.estimate).mockRejectedValue(new Error('boom'))
    renderPanel()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('読み込み中を出す', async () => {
    vi.mocked(api.estimate).mockReturnValue(new Promise(() => {}))
    renderPanel()
    await waitFor(() => expect(screen.getByText('見積もり中…')).toBeInTheDocument())
  })
})
