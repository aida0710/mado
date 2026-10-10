import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api/client'
import { LineageCatalog } from './LineageCatalog'

vi.mock('../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../lib/api/client')>()
  return { api: { ...mod.api, lineageCatalog: vi.fn() } }
})
afterEach(() => vi.clearAllMocks())

const dataset = {
  kind: 'dataset' as const, datasetId: 'dataset-1', datasetKey: 'callhome', namespace: 'speech', name: 'raw',
  displayName: 'CALLHOME raw', aliases: [], description: 'Purchased speech', mediaType: 'audio', owner: null,
  currentVersionId: 'version-1', versionCount: 2,
}

describe('LineageCatalog', () => {
  it('行のどこを押してもデータセットを選び、一覧を閉じる', async () => {
    vi.mocked(api.lineageCatalog).mockResolvedValue({ results: [dataset], totalCount: 1 })
    const onSelect = vi.fn()
    render(<LineageCatalog hasSelection={false} onSelect={onSelect} />)

    fireEvent.click(await screen.findByText('Purchased speech'))

    expect(onSelect).toHaveBeenCalledWith(dataset)
    expect(screen.getByRole('button', { name: '登録一覧・検索' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('行の詳細を開くボタンは、選ばずに説明とデータ形式を行の下に出す', async () => {
    vi.mocked(api.lineageCatalog).mockResolvedValue({ results: [dataset], totalCount: 1 })
    const onSelect = vi.fn()
    render(<LineageCatalog hasSelection={false} onSelect={onSelect} />)

    fireEvent.click(await screen.findByRole('button', { name: '詳細を表示' }))

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '詳細を閉じる' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('Purchased speech')).toHaveLength(2)
  })
})
