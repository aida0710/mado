import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinnedPreviewCard } from './PinnedPreviewCard'
import { PinnedPreviewsProvider, usePinnedPreviews, type PinnedItem } from '../lib/pinnedPreviews'

vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    textPreview: vi.fn(async () => 'hello text'),
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    tarEntryText: vi.fn(async () => 'entry text body'),
    imageUrl: vi.fn(() => 'http://x/image'),
  },
}))

// PreviewAudio は useAudioSrc / mediaAnalyze を叩くため、カードの分岐テストでは
// 「audio 種別のときにこのコンポーネントが選ばれる」ことだけを軽量に検証する。
vi.mock('./PreviewAudio', () => ({
  PreviewAudio: ({ k, entryPath }: { k: string; entryPath?: string }) => (
    <div data-testid="preview-audio">audio:{k}{entryPath ? `>${entryPath}` : ''}</div>
  ),
}))

afterEach(() => {
  vi.clearAllMocks()
})

function item(overrides: Partial<PinnedItem> = {}): PinnedItem {
  return {
    id: 'c|b|k.txt|',
    connId: 'c',
    bucket: 'b',
    key: 'k.txt',
    ...overrides,
  }
}

describe('PinnedPreviewCard - kind branching', () => {
  it('renders text preview for a plain text file', async () => {
    render(<PinnedPreviewCard item={item({ key: 'notes/readme.txt' })} />)
    expect(await screen.findByText('hello text')).toBeInTheDocument()
    // ヘッダはパス末尾を表示し、フルパスは title に持つ
    const title = screen.getByTitle('notes/readme.txt')
    expect(title).toHaveTextContent('readme.txt')
  })

  it('renders PreviewAudio for a direct audio file', () => {
    render(<PinnedPreviewCard item={item({ key: 'ch1.wav' })} />)
    expect(screen.getByTestId('preview-audio')).toHaveTextContent('audio:ch1.wav')
  })

  it('renders PreviewAudio with entryPath for a tar-entry audio pin', () => {
    render(<PinnedPreviewCard item={item({ key: 'shard.tar', entryPath: 'u1.wav', id: 'c|b|shard.tar|u1.wav' })} />)
    expect(screen.getByTestId('preview-audio')).toHaveTextContent('audio:shard.tar>u1.wav')
  })

  it('renders a lightweight tarEntryText body for a tar-entry text pin', async () => {
    render(<PinnedPreviewCard item={item({
      key: 'shard.tar', entryPath: 'meta.json', id: 'c|b|shard.tar|meta.json',
    })} />)
    expect(await screen.findByText('entry text body')).toBeInTheDocument()
    const title = screen.getByTitle('shard.tar › meta.json')
    expect(title).toHaveTextContent('meta.json')
  })

  it('shows the unsupported-kind fallback message for an unknown extension', () => {
    render(<PinnedPreviewCard item={item({ key: 'weird.xyz' })} />)
    expect(screen.getByText(/プレビュー非対応/)).toBeInTheDocument()
  })
})

describe('PinnedPreviewCard - remove', () => {
  it('the ✕ button calls removePin with the item id', () => {
    function Harness() {
      const { pins, addPin, removePin } = usePinnedPreviews()
      return (
        <div>
          <button onClick={() => addPin({ connId: 'c', bucket: 'b', key: 'a.txt' })}>add</button>
          {pins.map(p => <PinnedPreviewCard key={p.id} item={p} />)}
          <output data-testid="count">{pins.length}</output>
          {/* removePin を直接検証するためのスパイは使わず、実際に外れることで確認 */}
          <button onClick={() => pins[0] && removePin(pins[0].id)} hidden>noop</button>
        </div>
      )
    }
    render(<PinnedPreviewsProvider><Harness /></PinnedPreviewsProvider>)
    fireEvent.click(screen.getByText('add'))
    expect(screen.getByTestId('count').textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: /ピン留めを解除/ }))
    expect(screen.getByTestId('count').textContent).toBe('0')
  })
})
