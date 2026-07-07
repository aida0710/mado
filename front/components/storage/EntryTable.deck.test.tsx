import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PlayerDeckProvider, usePlayerDeck } from '../../lib/playerDeck'
import { EntryTable } from './EntryTable'

function DeckSpy() {
  const { tracks } = usePlayerDeck()
  return <output data-testid="count">{tracks.length}</output>
}

function setup(files: Array<{ key: string; size: number }>) {
  return render(
    <MemoryRouter>
      <PlayerDeckProvider>
        <EntryTable
          dirs={[]}
          files={files.map(f => ({ ...f, lastModified: null }))}
          prefix=""
          connId="c"
          bucket="b"
        />
        <DeckSpy />
      </PlayerDeckProvider>
    </MemoryRouter>,
  )
}

describe('EntryTable デッキ追加', () => {
  it('音声ファイルの ⋯ メニューに「デッキに追加」が出て、選ぶとデッキに積まれる', () => {
    setup([{ key: 'ch1.wav', size: 10 }])
    // CopyMenu のトリガー。既定 aria-label は「アクション」(CopyMenu.test.tsx / StorageBrowser.test.tsx と同じセレクタ)。
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('デッキに追加'))
    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  it('非音声ファイルには出ない', () => {
    setup([{ key: 'a.txt', size: 10 }])
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    expect(screen.queryByText('デッキに追加')).not.toBeInTheDocument()
  })
})
