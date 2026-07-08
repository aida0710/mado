import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { PinnedPreviewsProvider, usePinnedPreviews } from './pinnedPreviews'

function PinsSpy() {
  const { pins } = usePinnedPreviews()
  return <output data-testid="count">{pins.length}</output>
}

function AddButton({ n, connId = 'c', bucket = 'b' }: { n: number; connId?: string; bucket?: string }) {
  const { addPin } = usePinnedPreviews()
  return (
    <button onClick={() => addPin({ connId, bucket, key: `f${n}.txt` })}>
      add{n}
    </button>
  )
}

function setup() {
  return render(
    <PinnedPreviewsProvider>
      <AddButton n={1} />
      <AddButton n={2} />
      <PinsSpy />
    </PinnedPreviewsProvider>,
  )
}

describe('pinnedPreviews context', () => {
  it('starts empty', () => {
    setup()
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('adds pins in order and ignores duplicate pins', () => {
    setup()
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(screen.getByTestId('count').textContent).toBe('2')
  })

  it('removePin removes only the matching id', () => {
    function Harness() {
      const { pins, addPin, removePin } = usePinnedPreviews()
      return (
        <div>
          <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: 'f1.txt' })}>add1</button>
          <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: 'f2.txt' })}>add2</button>
          <button onClick={() => pins[0] && removePin(pins[0].id)}>removeFirst</button>
          <ul>{pins.map(p => <li key={p.id}>{p.key}</li>)}</ul>
        </div>
      )
    }
    render(<PinnedPreviewsProvider><Harness /></PinnedPreviewsProvider>)
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(screen.getByText('f1.txt')).toBeInTheDocument()
    expect(screen.getByText('f2.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByText('removeFirst'))
    expect(screen.queryByText('f1.txt')).not.toBeInTheDocument()
    expect(screen.getByText('f2.txt')).toBeInTheDocument()
  })

  it('clearPins empties the list', () => {
    function Harness() {
      const { pins, addPin, clearPins } = usePinnedPreviews()
      return (
        <div>
          <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: 'f1.txt' })}>add1</button>
          <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: 'f2.txt' })}>add2</button>
          <button onClick={clearPins}>clear</button>
          <output data-testid="count">{pins.length}</output>
        </div>
      )
    }
    render(<PinnedPreviewsProvider><Harness /></PinnedPreviewsProvider>)
    fireEvent.click(screen.getByText('add1'))
    fireEvent.click(screen.getByText('add2'))
    expect(screen.getByTestId('count').textContent).toBe('2')
    fireEvent.click(screen.getByText('clear'))
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('usePinnedPreviews outside a Provider returns a no-op API (does not throw)', () => {
    function Standalone() {
      const { pins, addPin, removePin, clearPins } = usePinnedPreviews()
      addPin({ connId: 'c', bucket: 'b', key: 'x.txt' })
      removePin('whatever')
      clearPins()
      return <output data-testid="count">{pins.length}</output>
    }
    render(<Standalone />)
    expect(screen.getByTestId('count').textContent).toBe('0')
  })
})

describe('pinnedPreviews across a route-driven remount (integration)', () => {
  // StoragePageWithKey (App.tsx) remounts the whole page tree via key={connId}
  // when navigating between directories/connections. PinnedPreviewsProvider must
  // sit above that remount point (like PlayerDeckProvider) so pins survive it.
  function DirLevel({ n }: { n: number }) {
    const { addPin } = usePinnedPreviews()
    return (
      <div>
        <span data-testid="level">{n}</span>
        <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: `dir${n}/f.txt` })}>
          pin{n}
        </button>
      </div>
    )
  }

  function Harness({ n }: { n: number }) {
    return (
      <MemoryRouter>
        <PinnedPreviewsProvider>
          {/* key={n} 相当の remount で「ディレクトリ遷移」を模す */}
          <DirLevel key={n} n={n} />
          <PinsSpy />
        </PinnedPreviewsProvider>
      </MemoryRouter>
    )
  }

  it('keeps pins across a remount of the routed subtree', () => {
    const { rerender } = render(<Harness n={1} />)
    fireEvent.click(screen.getByText('pin1'))
    expect(screen.getByTestId('count').textContent).toBe('1')

    // ディレクトリ遷移相当の再レンダ (subtree remount)
    rerender(<Harness n={2} />)
    expect(screen.getByTestId('level').textContent).toBe('2')
    expect(screen.getByTestId('count').textContent).toBe('1')

    fireEvent.click(screen.getByText('pin2'))
    expect(screen.getByTestId('count').textContent).toBe('2')
  })
})
