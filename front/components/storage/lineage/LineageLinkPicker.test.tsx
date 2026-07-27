import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineageLinkPicker } from './LineageLinkPicker'
import { api } from '../../../lib/api/client'

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return { api: { ...mod.api, buckets: vi.fn(), list: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

function setup() {
  vi.mocked(api.buckets).mockResolvedValue({
    buckets: [{ name: 'raw', creationDate: null }, { name: 'clean', creationDate: null }],
  })
  vi.mocked(api.list).mockResolvedValue({
    directories: ['2024-01/'], files: [{ key: 'meta.json', size: 10, lastModified: null }],
    nextContinuation: null, nextStartAfter: null,
  })
}

describe('LineageLinkPicker', () => {
  it('現在のディレクトリを選択できる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/2024-01\//)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'このバケット直下を選択' }))
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: '' })
  })

  it('ディレクトリ行の「選択」でそのディレクトリを選べる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/2024-01\//)).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: '選択' })[0])
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: '2024-01/' })
  })

  it('ファイル行の「選択」でそのファイルを選べる', async () => {
    setup()
    const onSelect = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={onSelect} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText(/meta\.json/)).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: '選択' })[1])
    expect(onSelect).toHaveBeenCalledWith({ bucket: 'raw', path: 'meta.json' })
  })

  it('除外ノード (自分自身) は選択できない', async () => {
    vi.mocked(api.buckets).mockResolvedValue({ buckets: [{ name: 'raw', creationDate: null }] })
    vi.mocked(api.list).mockResolvedValue({
      directories: [], files: [], nextContinuation: null, nextStartAfter: null,
    })
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'raw', path: '' }}
        onSelect={vi.fn()} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'このバケット直下を選択' })).toBeDisabled()
  })

  it('バケットを切り替えると prefix がリセットされ、そのバケットを一覧する', async () => {
    setup()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="deep/" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={vi.fn()} onCancel={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('c1', 'raw', 'deep/', {}, { recursive: false }))
    fireEvent.change(screen.getByLabelText('バケット'), { target: { value: 'clean' } })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith('c1', 'clean', '', {}, { recursive: false }))
  })

  it('キャンセルボタンで onCancel を呼ぶ', async () => {
    setup()
    const onCancel = vi.fn()
    render(
      <LineageLinkPicker
        connId="c1" initialBucket="raw" initialPrefix="" exclude={{ bucket: 'clean', path: 'v2/' }}
        onSelect={vi.fn()} onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
