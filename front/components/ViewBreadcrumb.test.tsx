import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../lib/api/types'
import { ConnectionContext } from '../lib/connectionContext'
import { copyToClipboard } from '../lib/clipboard'
import { ViewBreadcrumb } from './ViewBreadcrumb'
import { ALL_CAPABILITIES_ON } from '../lib/api/types'

vi.mock('../lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))

afterEach(() => vi.clearAllMocks())

const conn: Connection = {
  id: 'c1', name: 'mdx', endpoint: 'https://e', region: 'r',
  accessKeyIdMasked: '****', forcePathStyle: true, listObjectsVersion: 'v2',
  capabilities: ALL_CAPABILITIES_ON,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDefault: false,
}

function renderCrumb() {
  return render(
    <MemoryRouter>
      <ConnectionContext.Provider value={conn}>
        <ViewBreadcrumb connId="c1" label="タグ検索" href="/storage/c1/?view=tags" />
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

describe('ViewBreadcrumb', () => {
  it('接続名 › 現在地 を出す', () => {
    renderCrumb()
    expect(screen.getByRole('link', { name: 'mdx' })).toHaveAttribute('href', '/storage/c1/')
    expect(screen.getByText('タグ検索')).toBeInTheDocument()
  })

  it('↑ はバケット一覧へ戻る', () => {
    renderCrumb()
    expect(screen.getByRole('link', { name: 'バケット一覧へ' }))
      .toHaveAttribute('href', '/storage/c1/')
  })

  // ここは S3 上の場所ではないので、コピーできるのは Web URL だけ。
  it('⧉ は Web URL だけをコピーできる', async () => {
    const user = userEvent.setup()
    renderCrumb()

    await user.click(screen.getByRole('button', { name: 'このページの URL をコピー' }))
    expect(screen.queryByRole('menuitem', { name: /S3 URL/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: /Web URL をコピー/ }))
    expect(copyToClipboard)
      .toHaveBeenCalledWith(`${window.location.origin}/storage/c1/?view=tags`)
  })

  // 現在地を自分自身へのリンクにしない。
  it('現在地はリンクにしない', () => {
    renderCrumb()
    expect(screen.queryByRole('link', { name: 'タグ検索' })).not.toBeInTheDocument()
  })
})
