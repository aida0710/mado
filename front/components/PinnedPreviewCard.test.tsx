import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinnedPreviewCard } from './PinnedPreviewCard'
import { PinnedPreviewsProvider, usePinnedPreviews, type PinnedItem } from '../lib/pinnedPreviews'
import { api } from '../lib/api/client'
import { copyToClipboard } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    textPreviewUrl: vi.fn(() => 'http://x/text'),
    tarEntryUrl: vi.fn(() => 'http://x/entry'),
    imageUrl: vi.fn(() => 'http://x/image'),
    readHead: vi.fn(async () => new Uint8Array(0)),
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

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('PinnedPreviewCard - kind branching', () => {
  it('renders text preview for a plain text file', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello text'))
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
    vi.mocked(api.readHead).mockResolvedValue(utf8('entry text body'))
    render(<PinnedPreviewCard item={item({
      key: 'shard.tar', entryPath: 'meta.json', id: 'c|b|shard.tar|meta.json',
    })} />)
    expect(await screen.findByText('entry text body')).toBeInTheDocument()
    const title = screen.getByTitle('shard.tar › meta.json')
    expect(title).toHaveTextContent('meta.json')
  })

  it('NUL を含むファイルは「プレビュー非対応」になる (拡張子ではなく中身で判定)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new Uint8Array([0x93, 0x4e, 0x00]))
    render(<PinnedPreviewCard item={item({ key: 'weird.xyz' })} />)
    expect(await screen.findByText(/プレビュー非対応/)).toBeInTheDocument()
  })

  it('拡張子が未知でも中身がテキストなら開ける', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('FROM alpine'))
    render(<PinnedPreviewCard item={item({ key: 'Dockerfile' })} />)
    expect(await screen.findByText('FROM alpine')).toBeInTheDocument()
  })

  it('単体テキストファイルのピンは固定高さの pre で表示される', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('plain body'))
    render(<PinnedPreviewCard item={{ id: 'i1', connId: 'c', bucket: 'b', key: 'x.txt' }} />)
    const pre = await screen.findByText('plain body')
    expect(pre.tagName).toBe('PRE')
    expect(pre.className).toContain('h-[280px]')
  })

  it('tar エントリのテキストも固定高さの pre で表示される', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('hello'))
    render(<PinnedPreviewCard item={{ id: 'i2', connId: 'c', bucket: 'b', key: 's.tar', entryPath: 'u.txt' }} />)
    const pre = await screen.findByText('hello')
    expect(pre.tagName).toBe('PRE')
    expect(pre.className).toContain('h-[280px]')
  })

  it('単体 .json のピンは minify されていてもプリティプリントされる', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1,"b":2}'))
    const { container } = render(
      <PinnedPreviewCard item={{ id: 'j1', connId: 'c', bucket: 'b', key: 'x.json' }} />,
    )
    await screen.findByText(/"a": 1/)
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })

  it('tar エントリの .json もプリティプリントされる', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"x":true}'))
    const { container } = render(
      <PinnedPreviewCard item={{ id: 'j2', connId: 'c', bucket: 'b', key: 's.tar', entryPath: 'meta.json' }} />,
    )
    await screen.findByText(/"x": true/)
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "x": true\n}')
  })

  it('不正な JSON の .json はそのまま表示される (整形は try/catch でフォールバック)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{oops not json'))
    const { container } = render(
      <PinnedPreviewCard item={{ id: 'j3', connId: 'c', bucket: 'b', key: 'bad.json' }} />,
    )
    await screen.findByText('{oops not json')
    expect(container.querySelector('pre')?.textContent).toBe('{oops not json')
  })

  it('.jsonl は1行1値なので整形せずそのまま表示される', async () => {
    vi.mocked(api.readHead).mockResolvedValue(utf8('{"a":1}\n{"b":2}'))
    const { container } = render(
      <PinnedPreviewCard item={{ id: 'j4', connId: 'c', bucket: 'b', key: 'data.jsonl' }} />,
    )
    await screen.findByText(/"a":1/)
    expect(container.querySelector('pre')?.textContent).toBe('{"a":1}\n{"b":2}')
  })
})

describe('PinnedPreviewCard - head モード', () => {
  it('tar エントリのテキスト取得は maxBytes 付き URL を使う (100MB を解凍させない)', async () => {
    vi.mocked(api.readHead).mockResolvedValue(new TextEncoder().encode('body'))
    render(<PinnedPreviewCard item={item({ key: 's.tar', entryPath: 'x.bin', id: 'c|b|s.tar|x.bin' })} />)
    await screen.findByText('body')
    const calls = vi.mocked(api.tarEntryUrl).mock.calls
    expect(calls.some(c => c[4]?.maxBytes === 65536)).toBe(true)
  })
})

describe('PinnedPreviewCard - パスのコピー', () => {
  it('ファイル名をクリックするとフルパスがコピーされる (画面は basename しか出せない)', async () => {
    render(<PinnedPreviewCard item={item({
      key: 'rec/shard.tar', entryPath: 'audio/u1.wav', id: 'c|b|rec/shard.tar|audio/u1.wav',
    })} />)
    const label = screen.getByTitle('rec/shard.tar › audio/u1.wav')
    expect(label).toHaveTextContent('u1.wav')
    fireEvent.click(label)
    expect(copyToClipboard).toHaveBeenCalledWith('rec/shard.tar › audio/u1.wav')
    await waitFor(() => expect(label).toHaveTextContent('コピーしました ✓'))
  })

  it('単体ファイルは key をそのままコピーする', () => {
    render(<PinnedPreviewCard item={item({ key: 'notes/readme.txt' })} />)
    fireEvent.click(screen.getByTitle('notes/readme.txt'))
    expect(copyToClipboard).toHaveBeenCalledWith('notes/readme.txt')
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
