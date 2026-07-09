import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PinnedPreviewsProvider, usePinnedPreviews } from '../../lib/pinnedPreviews'
import { EntryTable } from './EntryTable'

function PinsSpy() {
  const { pins } = usePinnedPreviews()
  return <output data-testid="count">{pins.length}</output>
}

function setup(files: Array<{ key: string; size: number }>) {
  return render(
    <MemoryRouter>
      <PinnedPreviewsProvider>
        <EntryTable
          dirs={[]}
          files={files.map(f => ({ ...f, lastModified: null }))}
          prefix=""
          connId="c"
          bucket="b"
        />
        <PinsSpy />
      </PinnedPreviewsProvider>
    </MemoryRouter>,
  )
}

describe('EntryTable ピン留め', () => {
  it('プレビュー可能な種別の ⋯ メニューに「ピン留め」が出て、選ぶとピンに積まれる', () => {
    setup([{ key: 'notes.txt', size: 10 }])
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('ピン留め'))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('unknown 種別のファイルにも出る (中身を見るまでテキストか分からないため)', () => {
    setup([{ key: 'a.weird', size: 10 }])
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('ピン留め'))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })
})
