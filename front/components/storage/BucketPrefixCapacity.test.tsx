import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api/client'
import type { CapacityPrefixSummary } from '../../lib/api/types'
import { BucketPrefixCapacity } from './BucketPrefixCapacity'

afterEach(() => vi.restoreAllMocks())

const prefix = (name: string, totalBytes: number, previousBytes: number | null = null): CapacityPrefixSummary => ({
  prefix: name, totalBytes, objectCount: 10,
  previous: previousBytes === null ? null : { totalBytes: previousBytes, objectCount: 8 },
})

function mount(prefixes: CapacityPrefixSummary[], bucketTotalBytes = 2048) {
  return render(
    <MemoryRouter>
      <BucketPrefixCapacity
        connectionId="c1" bucket="dataset"
        bucketTotalBytes={bucketTotalBytes} bucketObjectCount={100}
        prefixes={prefixes} days={30} intervalSeconds={86400}
      />
    </MemoryRouter>,
  )
}

function rowNames(): string[] {
  return screen.getAllByRole('button', { name: /\/$/ }).map(button => button.textContent?.replace(/^[▸▾]/, '') ?? '')
}

describe('BucketPrefixCapacity', () => {
  it('ディレクトリごとに容量・割合・前回からの増減を出す', () => {
    mount([prefix('ja/', 1024, 512), prefix('en/', 512)])
    const jaRow = screen.getByRole('button', { name: 'ja/' }).closest<HTMLElement>('[role="row"]')!
    expect(within(jaRow).getByText('1 KiB')).toBeInTheDocument()
    expect(within(jaRow).getByText('50.0%')).toBeInTheDocument()
    expect(within(jaRow).getByText('+512 B (+100.0%)')).toBeInTheDocument()
    const enRow = screen.getByRole('button', { name: 'en/' }).closest<HTMLElement>('[role="row"]')!
    expect(within(enRow).getByText('—')).toBeInTheDocument()
  })

  it('ディレクトリ名のリンクから一覧画面のそのディレクトリへ移動できる', () => {
    mount([prefix('日本語 dir/', 1024)])
    expect(screen.getByRole('link', { name: '日本語 dir/を開く' }))
      .toHaveAttribute('href', '/storage/c1/dataset/%E6%97%A5%E6%9C%AC%E8%AA%9E%20dir/')
  })

  it('上位5件だけを出し、残りは押すと表示する', async () => {
    mount(Array.from({ length: 7 }, (_, index) => prefix(`d${index}/`, 100 - index)), 1000)
    expect(rowNames()).toEqual(['d0/', 'd1/', 'd2/', 'd3/', 'd4/'])
    expect(screen.queryByText('直下のファイル・上位に入らないディレクトリ')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '残り2件も表示' }))
    expect(rowNames()).toHaveLength(7)
    // 7件の合計は 679 B。バケット全体 1000 B との差が内訳に入らなかった残り。
    const restRow = screen.getByText('直下のファイル・上位に入らないディレクトリ').closest<HTMLElement>('[role="row"]')!
    expect(within(restRow).getByText('321 B')).toBeInTheDocument()
  })

  it('行を開くとそのディレクトリの推移を取得する', async () => {
    const history = vi.spyOn(api, 'capacityPrefixHistory').mockResolvedValue({
      points: [{ totalBytes: 1, objectCount: 1, collectedAt: '2026-09-28T00:00:00Z' }],
    })
    mount([prefix('ja/', 1024)])
    const toggle = screen.getByRole('button', { name: 'ja/' })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(history).toHaveBeenCalledWith({ connectionId: 'c1', bucket: 'dataset', prefix: 'ja/', days: 30 })
    expect(await screen.findByText('2回計測するとグラフを表示します')).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('2回計測するとグラフを表示します')).toBeNull()
  })

  it('内訳が無いときはその理由の候補を出す', () => {
    mount([])
    expect(screen.getByText(/直下のディレクトリ別の内訳はありません/)).toBeInTheDocument()
  })
})
