import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Breadcrumb } from './Breadcrumb'
import { ConnectionContext } from '../lib/connectionContext'
import type { Connection } from '../lib/api/types'

const conn: Connection = {
  id: 'c1',
  name: 'mdx',
  endpoint: 'https://example.com',
  region: 'auto',
  accessKeyIdMasked: '****',
  forcePathStyle: true,
  listObjectsVersion: 'v2',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function renderBreadcrumb(prefix: string) {
  return render(
    <MemoryRouter>
      <ConnectionContext.Provider value={conn}>
        <Breadcrumb connId="c1" bucket="dataset" prefix={prefix} />
      </ConnectionContext.Provider>
    </MemoryRouter>,
  )
}

const COPY = 'このディレクトリの URL をコピー'

describe('Breadcrumb - 現在地コピーメニュー', () => {
  it('深い階層では prefix 末尾スラッシュ込みの s3:// と Web URL を出す', async () => {
    const user = userEvent.setup()
    renderBreadcrumb('emilia/sidon/')
    await user.click(screen.getByRole('button', { name: COPY }))

    const s3Item = screen.getByRole('menuitem', { name: /S3 URL をコピー/ })
    expect(s3Item).toHaveAttribute('title', 's3://dataset/emilia/sidon/')

    const webItem = screen.getByRole('menuitem', { name: /Web URL をコピー/ })
    expect(webItem).toHaveAttribute(
      'title',
      `${window.location.origin}/storage/c1/dataset/emilia/sidon/`,
    )
  })

  it('バケット直下 (prefix 空) では s3://<bucket>/ を出す (最浅条件)', async () => {
    const user = userEvent.setup()
    renderBreadcrumb('')
    await user.click(screen.getByRole('button', { name: COPY }))

    expect(screen.getByRole('menuitem', { name: /S3 URL をコピー/ }))
      .toHaveAttribute('title', 's3://dataset/')
    expect(screen.getByRole('menuitem', { name: /Web URL をコピー/ }))
      .toHaveAttribute('title', `${window.location.origin}/storage/c1/dataset/`)
  })
})
