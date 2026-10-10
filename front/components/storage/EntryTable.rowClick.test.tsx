import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { PinnedPreviewsProvider } from '../../lib/pinnedPreviews'
import { EntryTable } from './EntryTable'

function LocationSpy() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function setup({ dirs = [], files = [] }: { dirs?: string[]; files?: string[] }) {
  const onSelectFile = vi.fn()
  render(
    <MemoryRouter initialEntries={['/storage/c/b/']}>
      <PinnedPreviewsProvider>
        <EntryTable
          dirs={dirs}
          files={files.map(key => ({ key, size: 2048, lastModified: '2026-10-10T00:00:00Z' }))}
          prefix=""
          connectionId="c"
          bucket="b"
          onSelectFile={onSelectFile}
        />
        <LocationSpy />
      </PinnedPreviewsProvider>
    </MemoryRouter>,
  )
  return { onSelectFile }
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByTitle(name).closest('tr')
  if (!row) throw new Error(`row not found: ${name}`)
  return row
}

describe('EntryTable 行を押したとき', () => {
  it('ディレクトリの行は、名前以外の場所を押しても開く', () => {
    setup({ dirs: ['audio/'] })
    const row = rowOf('audio/')
    fireEvent.click(row.querySelectorAll('td')[1])
    expect(screen.getByTestId('location').textContent).toBe('/storage/c/b/audio/')
  })

  it('ディレクトリの行の操作のメニューを押しても、ディレクトリは開かない', () => {
    setup({ dirs: ['audio/'] })
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    expect(screen.getByTestId('location').textContent).toBe('/storage/c/b/')
  })

  it('ファイルの行は、名前以外の場所を押してもプレビューを開く', () => {
    const { onSelectFile } = setup({ files: ['notes.txt'] })
    fireEvent.click(rowOf('notes.txt').querySelectorAll('td')[1])
    expect(onSelectFile).toHaveBeenCalledWith('notes.txt')
  })

  it('行の中の文字を選択し終えたときは、開かない', () => {
    const { onSelectFile } = setup({ files: ['notes.txt'] })
    const name = screen.getByTitle('notes.txt')
    window.getSelection()?.selectAllChildren(name)
    fireEvent.click(name)
    expect(onSelectFile).not.toHaveBeenCalled()
    window.getSelection()?.removeAllRanges()
  })
})
